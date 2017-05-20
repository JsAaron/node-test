/*********************************************************************
 *            调度器 生成页面模块
 *            处理：事件动作分派
 *            调度：
 *                1. PageMgr     模块
 *                2. MasterMgr 模块                                                          *
 **********************************************************************/

import { config } from '../../config/index'
import PageMgr from '../manage/page'
import MasterMgr from '../manage/master'
import goToPage from './jump-page'
import Stack from '../../util/stack'

import { sceneController } from '../factory/control'
import { getVisualDistance } from '../v-distance/index'
import { setCustomStyle } from '../v-style/index'
import { getVisualMode } from './mode'
import { $set, hash, $warn } from '../../util/index'

import {
  initPointer,
  getPosition,
  getRealPage,
  converVisualPid,
  converDoublePage,
  converChapterData,
  converChapterIndex,
  hasMaster
} from './depend'


/*
获取双页参数
1:从属的主索引
2:摆放位置
 */
const getDoubleOption = function(chapterIndex, doublePage) {
  if (doublePage.total) {
    for (let key in doublePage) {
      if (key !== 'total') {
        let doubleData = doublePage[key]
        let index = doubleData.indexOf(chapterIndex)
        if (~index) {
          return {
            doubleMainIndex: Number(key),
            doublePosition: index == 0 ? 'left' : 'right'
          }
        }
      }
    }
  }
  return {
    doubleMainIndex: undefined,
    doublePosition: undefined
  }
}


export default class Scheduler {

  constructor($$mediator) {

    this.$$mediator = $$mediator;

    //创建前景页面管理模块
    this.pageMgr = new PageMgr($$mediator.options.scenePageNode)

    //检测是否需要创母版模块
    if (hasMaster()) {
      this.masterMgr = new MasterMgr($$mediator.options.sceneMasterNode);
    }
  }

  /**
   * 初始化页面创建
   * 因为多个页面的问题，所以不是创建调用
   * 提供外部接口启动创建
   */
  initCreate() {
    const options = this.$$mediator.options
    const pointer = initPointer(options.initIndex, options.pageTotal, options.hasMultiPage)
    this.pagePointer = pointer.initPointer
    this.createPageBase(pointer.createPointer, options.initIndex, 'init', '', '')
  }


  /**
   *  创建普通页面
   *  创建母版页面
   *  createSinglePage  需要创建的单页面索引
   *  visualPageIndex   当前可视区页面索引
   *  action            创建的动作：toPage/init/flipOver
   *  toPageCallback    跳转页面支持回调通知
   *  userStyle         规定创建的style属性
   *
   * 2017.3.27增加createDoublePage
   *   创建双页的页面记录
   *   createPageIndex中对应的createDoublePage如果有子索引值
   *
   * 流程：
   * 1：传递页面索引createSinglePage  [0]/[0,1]/[0,1,2]
   * 2: 转化索引为chpaterInder的排序，把索引提出当期显示页面最先解析， 如果是非线性，需要转化对应的chpaterIndex ,[1,0,2]
   * 3：通过编译chpaterInder的合集，获取到每一个chapter页面的数据
   * 4：由于非线性存在， 每一个新的场景，可包含有多个chpater，pageIndex都是从0开始的. chapterIndex，不一定是从0开始的
   * 5: 解析出pageIndex，visualChapterIndex的数值
   * 6：自定义每一个页面的样式styleDataset
   * 7：调用page/master管理器，创建pagebase
   **/
  createPageBase(createSinglePage, visualPageIndex, action, toPageCallback, userStyle) {

    //2016.1.20
    //修正苗苗学问题 确保createPage不是undefined
    if (createSinglePage[0] === undefined) {
      return;
    }

    const self = this
    const options = this.$$mediator.options
    const hasMultiPage = options.hasMultiPage //是否线性
    const isToPageAction = action === 'toPage' //如果是跳转
    const isFlipAction = action === 'flipOver' //如果是翻页

    /*启动了双页模式，单页转化双页*/
    const createDoublePage = converDoublePage(createSinglePage, true)

    /* 需要创建的总页面，双页面或者单页面*/
    let createTotal = createDoublePage.total || createSinglePage.length

    /*
    转化页面合集，自然索引index => chapter Index
    传递的页面的索引永远只是从0,1,2....这样的自然排序
    1.最后需要把最先展示的页面提取到第一位解析，加快页面展示
    2.如果是非线性的多场景应用，那么这样的自然排序，需要转化成对应的chapter的索引(为了直接获取chapter的数据)
    */
    let createChpaterIndexGroup = converChapterIndex(options, createSinglePage, createDoublePage, visualPageIndex)

    /*
     收集创建的页面对象
     1.用于处理2个页面在切换的时候闪屏问题
     2.主要是传递createStyle自定义样式的处理
      */
    let collectPageBase = []

    /*
    是否触发母版的自动时间
    因为页面每次翻页都会驱动auto事件
    但是母版可能是共享的
     */
    let createMaster = false

    //收集完成回调
    const collectCallback = (() => {
      //收集创建页码的数量
      let createContent = 0;
      return callback => {
        ++createContent
        if (createContent === createTotal) {
          callback();
        }
      }
    })()

    //构建执行代码
    const callbackAction = {
      /*初始化完毕*/
      init() {
        collectCallback(() => {
          self._initPage('init');
        })
      },
      /*翻页完毕，运行自动*/
      flipOver() {
        collectCallback(() => {
          self._runPageBase({
            'createPointer': createChpaterIndexGroup,
            'createMaster': createMaster
          });
        })
      },
      /*跳转处理*/
      toPage() {
        collectCallback(() => {
          toPageCallback(collectPageBase);
        })
      }
    }

    /**
     * 预编译
     * 因为要需要对多个页面进行预处理
     * 需要同步多个页面数据判断
     * 这样需要预编译出数据，做了中间处理后再执行后续动作
     * @type {Array}
     */
    const compile = new Stack()

    /*收集有用的数据*/
    const styleDataset = hash()

    /*双页，初始化页面的Translate容器坐标*/
    if (action === 'init') {
      this.pageMgr.setInitTranslate(visualPageIndex)
    }

    /*
      1.pageIndex：页面自然索引号
      2.visualPageIndex：页面自然索引号，可见编号

      3.chapterIndex： 页面chpater的索引号
      4.visualChapterIndex:  可见页面的的chpater索引号
     */
    _.each(createChpaterIndexGroup, chapterIndex => {

      compile.push((() => {

        /*
        双页模式
        1:子页面从属主页面，一左一右从属
          比如子页面   chapterIndex：  [2,3,0,1,4,5]
          从属的主页面 belongMainIndex:[1,1,0,0,2,2]

        2:计算页面是左右摆放位置
          position: left/right
         */
        const { doubleMainIndex, doublePosition } = getDoubleOption(chapterIndex, createDoublePage)

        const chapterData = converChapterData(chapterIndex)

        /*
        1.转化可视区页码对应的chapter的索引号
        2.获取出实际的pageIndex自然索引号
        因为多场景的情况下
        chapterIndex != pageIndex
        每一个新的场景，可包含有多个chpater，pageIndex都是从0开始的
        chapterIndex，不一定是从0开始的
        */
        const { visualChapterIndex, pageIndex } = converVisualPid(options, chapterIndex, visualPageIndex)

        if (createTotal === 1) {
          options.chapterId = chapterData._id
        }

        /*
        跳转的时候，创建新页面可以自动样式信息
        优化设置，只是改变当前页面即可
        */
        if (isToPageAction && visualChapterIndex !== chapterIndex) {
          userStyle = undefined
        }

        /*自定义页面的style属性*/
        styleDataset[chapterIndex] = {
          userStyle,
          chapterIndex,
          visualChapterIndex,
          doublePosition, //双页面位置
          doubleMainIndex, //从属主页面，双页模式
          /*页面的布局位置*/
          position: getPosition(doubleMainIndex !== undefined ? doubleMainIndex : chapterIndex, visualChapterIndex),
          pageVisualMode: getVisualMode(chapterData)
        }

        ///////////////////////////
        /// 延迟创建,先处理style规则
        ///////////////////////////
        return pageStyle => {
          //创建新的页面管理，masterFilter 母板过滤器回调函数
          const _createPageBase = function(masterFilter) {

            //初始化构建页面对象
            //1:page，2:master
            let currentStyle = pageStyle[chapterIndex]
            let pageBase = this.create({
              pageIndex,
              chapterData,
              chapterIndex,
              hasMultiPage,
              'getStyle': currentStyle
            }, pageIndex, masterFilter, function(shareMaster) {
              if (config.debug.devtools && shareMaster.getStyle.pageVisualMode !== currentStyle.pageVisualMode) {
                $warn(`母版与页面VisualMode不一致,错误页码:${pageIndex+1},母版visualMode:${shareMaster.getStyle.pageVisualMode},页面visualMode:${currentStyle.pageVisualMode}`)
              }
            })

            //判断pageBase是因为母版不需要重复创建
            //母版是共享多个paga
            if (pageBase) {
              //开始线程任务，如果是翻页模式,支持快速创建
              pageBase.startThreadTask(isFlipAction, () => {
                callbackAction[action]()
              })

              //收集自定义样式的页面对象
              if (userStyle) {
                collectPageBase.push(pageBase)
              }
            }
          }

          //创建母版层
          if (chapterData.pptMaster && self.masterMgr) {
            _createPageBase.call(self.masterMgr, () => {
              //母版是否创建等待通知
              //母版是共享的所以不一定每次翻页都会创建
              //如果需要创建,则叠加总数
              ++createTotal
              createMaster = true
            })
          }

          //创建页面层
          _createPageBase.call(self.pageMgr)
        }

      })())
    })

    /**
     * 创建页面的样式与翻页的布局
     * 存在存在flows页面处理
     * 这里创建处理的Transfrom
     */
    compile.shiftAll(setCustomStyle(styleDataset)).destroy()
  }


  /**
   * 滑动处理
   *  1 滑动
   *  2 反弹
   *  3 翻页
   */
  movePageBases(options) {

    const {
      action,
      speed,
      outerCallFlip,
      distance,
      frontIndex,
      middleIndex,
      backIndex,
      direction,
      orientation,
      isAppBoundary, //应用边界反弹
      setSwipeInvalid //设置翻页无效
    } = options

    //用户强制直接切换模式
    //禁止页面跟随滑动
    if (config.launch.banMove && action == 'flipMove') {
      return
    }

    let visualObj = this.pageMgr.$$getPageBase(middleIndex)

    //2016.11.8
    //mini杂志功能
    //一次是拦截
    //一次是触发动作
    if (config.launch.swipeDelegate && visualObj) {

      //如果是swipe就全局处理
      if (action === 'swipe') {
        //执行动画序列
        visualObj.callSwipeSequence(direction)
        return
      }

      //2016.11.8
      //mini杂志功能
      //如果有动画序列
      //拦截翻页动作
      //执行序列动作
      //拦截
      if (visualObj.hasSwipeSequence(direction)) {
        //设置为无效翻页
        setSwipeInvalid && setSwipeInvalid()
        return
      }
    }


    /*视觉差页面滑动*/
    let nodes
    if (visualObj) {
      const chapterData = visualObj.chapterData
      nodes = chapterData && chapterData.nodes ? chapterData.nodes : undefined
    }

    /*移动的距离,合集*/
    const moveDistance = getVisualDistance({
      action,
      distance,
      direction,
      frontIndex,
      middleIndex,
      backIndex,
      orientation
    })

    const data = {
      nodes,
      speed,
      action,
      outerCallFlip,
      moveDistance,
      direction,
      frontIndex,
      middleIndex,
      backIndex
    }

    /*移动页面*/
    this.pageMgr.move(data)
    this.getMasterContext(function() { this.move(data, isAppBoundary) })

    //更新页码
    if (action === 'flipOver') {
      Xut.nextTick(() => {
        this.$$mediator.$emit('change:pageUpdate', {
          action,
          parentIndex: direction === 'next' ? backIndex : frontIndex,
          direction
        })
      })
    }
  }


  /**
   * 翻页松手后
   * 暂停页面的各种活动动作
   */
  suspendPageBases(options) {

    let { frontIndex, middleIndex, backIndex, stopIndex } = options

    /*暂停*/
    const suspendAction = (front, middle, back, stop) => {
      this.pageMgr.suspend(front, middle, back, stop)
      this.getMasterContext(function() { this.suspend(stop) })
    }

    const stopPageIndexs = converDoublePage(stopIndex)

    /*多页面,停止每个页面的动作
    1.停止的可能是多页面
    2.转化对应的页面数据，用于停止页面任务创建*/
    if (stopPageIndexs && stopPageIndexs.length) {
      const leftIds = converDoublePage(frontIndex)
      const currIds = converDoublePage(middleIndex)
      const rightIds = converDoublePage(backIndex);
      /**
       * 因为stopPageIndexs是数组形式，
       * 所以会调用多次相同的任务关闭操作
       * 所以这里为了优化，强制只处理一次
       */
      let onlyonce = false
      stopPageIndexs.forEach(index => {
        if (onlyonce) {
          /*只关闭，任务不需要重复再处理了*/
          suspendAction('', '', '', index)
        } else {
          suspendAction(leftIds, currIds, rightIds, index)
          onlyonce = true
        }
      })
    } else {
      /*单页面*/
      suspendAction(frontIndex, middleIndex, backIndex, stopIndex)
    }

    //复位工具栏
    this.$$mediator.$emit('change:resetToolbar')
  }


  /**
   * 翻页动画完毕后
   * 1.需要解锁页面滑动
   * 2.需要创建更新页面
   * 3.需要清理页面
   */
  completePageBases(options) {
    const { direction, pagePointer, unlock, isQuickTurn } = options
    /*方向*/
    this.direction = direction;
    /*是否快速翻页*/
    this.isQuickTurn = isQuickTurn || false;
    /*翻页解锁*/
    this.unlock = unlock;
    /*清理上一个页面*/
    this._clearPage(pagePointer.destroyIndex);
    /*更新索引*/
    this._updatePointer(pagePointer);
    //预创建下一页
    this._createNextPage(direction, pagePointer);
  }


  /**
   * 自动运行处理
   *  流程四:执行自动触发动作
   *   1.初始化创建页面完毕
   *   2.翻页完毕
   *   3.跳转后
   */
  _runPageBase(para) {

    let $$mediator = this.$$mediator
    let options = this.$$mediator.options
    let pagePointer = this.pagePointer
    let frontIndex = pagePointer.frontIndex
    let middleIndex = pagePointer.middleIndex
    let backIndex = pagePointer.backIndex
    let action = para ? para.action : ''
    let createPointer = para ? para.createPointer : ''
    let direction = this.direction

    /*跳转与翻页的情况下，转化页码标记*/
    if (createPointer) {
      createPointer = converVisualPid(options, createPointer)
    }

    const data = {
      frontIndex,
      middleIndex,
      backIndex,
      direction,
      createPointer,
      'isQuickTurn': this.isQuickTurn,
      /*暂停的页面索引autorun*/
      'suspendIndex': (action === 'init' ? '' : direction === 'next' ? frontIndex : backIndex),
      //中断通知
      'suspendCallback': options.suspendAutoCallback,
      //流程结束通知
      //包括动画都已经结束了
      'processComplete': function() {},
      //构建完毕通知
      'buildComplete': function(seasonId) {
        /**
         * 构建完成通知,用于处理历史缓存记录
         * 如果是调试模式 && 不是收费提示页面 && 多场景应用
         */
        if (config.launch.historyMode && !options.isInApp && options.hasMultiScene) {
          const history = sceneController.sequence(seasonId, middleIndex)
          if (history) { $set("history", history) }
        }
      }
    }

    //页面自动运行
    this.pageMgr.autoRun(data);

    //模板自动运行
    this.getMasterContext(function() {
      //如果动作是初始化，或者触发了母版自动运行
      //如果是越界处理
      //console.log(action,this.isBoundary,para.createMaster)
      if (action || this.isBoundary) {
        this.autoRun(data);
      }
    })

    /*初始化与跳转针对翻页案例的设置逻辑*/
    const setToolbar = () => {
      //不显示首尾对应的按钮
      if (middleIndex == 0) {
        $$mediator.$emit('change:hidePrev');
      } else if (middleIndex == options.pageTotal - 1) {
        $$mediator.$emit('change:hideNext');
        $$mediator.$emit('change:showPrev');
      } else {
        $$mediator.$emit('change:showNext');
        $$mediator.$emit('change:showPrev');
      }
    }

    switch (action) {
      case 'init':
        //更新页码标示
        $$mediator.$emit('change:pageUpdate', {
          action,
          parentIndex: middleIndex,
          direction
        })
        setToolbar.call(this)
        break;
      case 'toPage':
        //更新页码标示
        $$mediator.$emit('change:pageUpdate', {
          action,
          parentIndex: middleIndex,
          direction
        })
        setToolbar.call(this)
        break;
    }

    /**
     * 线性结构
     * 保存目录索引
     */
    if (config.launch && config.launch.historyMode && !options.hasMultiScene) {
      $set("pageIndex", middleIndex);
    }

    /**
     * 解锁翻页
     * 允许继续执行下一个翻页作用
     */
    if (this.unlock) {
      this.unlock();
      this.unlock = null;
    }

    //关闭快速翻页
    this.isQuickTurn = false;
  }


  /**
   * 清理页面结构,双页与单页
   */
  _clearPage(destroyIndex) {
    getRealPage(destroyIndex, 'clearPage').forEach(index => {
      this.pageMgr.clearPage(index)
    })
  }


  /**
   * 更新页码索引标示
   */
  _updatePointer(pointer) { this.pagePointer = pointer }


  /**
   * 预创建新页面
   */
  _createNextPage(direction, pagePointer) {

    const pageTotal = this.$$mediator.options.pageTotal
    const createIndex = pagePointer.createIndex
    const middleIndex = pagePointer.middleIndex

    /*清理页码*/
    const clearPointer = function() {
      pagePointer.createIndex = null
      pagePointer.destroyIndex = null
    }

    /*创建新的页面对象*/
    const createNextPageBase = () => this.createPageBase([createIndex], middleIndex, 'flipOver')

    //如果是左边翻页
    if (direction === 'prev') {
      //首尾无须创建页面
      if (middleIndex === 0) {
        this._runPageBase()
        if (pageTotal == 2) { //如果总数只有2页，那么首页的按钮是关闭的，需要显示
          this.$$mediator.$emit('change:showNext')
        }
        this.$$mediator.$emit('change:hidePrev')
        return
      }
      if (middleIndex > -1) { //创建的页面
        createNextPageBase()
        clearPointer()
        this.$$mediator.$emit('change:showNext')
        return;
      }
    }

    //如果是右边翻页
    if (direction === 'next') {
      //首尾无须创建页面
      if (middleIndex === pageTotal - 1) {
        this._runPageBase()
        if (pageTotal == 2) { //如果总数只有2页，那么首页的按钮是关闭的，需要显示
          this.$$mediator.$emit('change:showPrev')
        }
        //多页处理
        this.$$mediator.$emit('change:hideNext')
        return
      }
      if (createIndex < pageTotal) { //创建的页面
        createNextPageBase()
        clearPointer()
        this.$$mediator.$emit('change:showPrev')
        return
      }
    }

    clearPointer()

    return
  }


  /**
   * 页面跳转
   */
  gotoPageBases(data) {

    Xut.View.ShowBusy()

    //如果是非线性,创建页面修改
    if (!this.$$mediator.options.hasMultiPage) {
      data.create = [data.targetIndex]; //创建
      data.destroy = [data.visualIndex]; //销毁
      data.ruleOut = [data.targetIndex]; //排除已存在
      /*更新索引值*/
      data.pagePointer = {
        middleIndex: data.targetIndex
      }
    }

    //执行页面切换
    goToPage(this, data, function(data) {
      this._updatePointer(data.pagePointer);
      this._runPageBase({
        'action': 'toPage',
        'createPointer': data.create
      });
      Xut.View.HideBusy();
    })
  }


  /**
   * 调用母版管理器
   */
  getMasterContext(callback) {
    if (this.masterMgr) {
      callback.call(this.masterMgr)
    }
  }

  /**
   * 销毁接口
   * 销毁页面的所有的管理
   * 一般是退出处理
   */
  destroyManage() {
    this.pageMgr.destroyManage()
    this.getMasterContext(function() {
      this.destroyManage()
    })
  }


  /*
   *加载页面事件与动作
   *每次初始化一个新的场景都会触发
   */
  _initPage(action) {

    const autoRun = () => this._runPageBase({ action })

    //触发自动任务
    const triggerAuto = () => {
      //第一次进入，处理背景
      let $cover = $(".xut-cover")
      if ($cover.length) { //主动探测,只检查一次
        let complete = function() {
          $cover && $cover.remove()
          $cover = null
          autoRun()
        }

        //是否配置启动动画关闭
        if (config.launch.launchAnim === false) {
          complete()
        } else {
          //有动画
          $cover.transition({
            opacity: 0,
            duration: 1000,
            easing: 'in',
            complete
          });
        }
      }
      //第二次
      else {
        $cover = null
        autoRun()
      }
    }

    //创建完成回调
    this.$$mediator.$emit('change:createComplete', () => {
      if (this.$$mediator.options.hasMultiScene) {
        triggerAuto()
      }
      //第一次加载
      //进入应用
      else {
        if (window.GLOBALIFRAME) {
          triggerAuto()
          return
        }
        //获取应用的状态
        if (Xut.Application.getAppState()) {
          //保留启动方法
          var pre = Xut.Application.LaunchApp;
          Xut.Application.LaunchApp = function() {
            pre()
            triggerAuto()
          };
        } else {
          triggerAuto()
        }
      }
    })
  }

}