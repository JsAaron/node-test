import css3 from './css3'
import keyframe from './keyframe'

const prefix = Xut.plat.prefixStyle

//判断是否支持css3属性
const supportCss3Property = prefix('animation-play-state')

/**
 * css3动画
 * 1 帧动画
 * 2 定时器动画
 * @param {[type]} options [description]
 */
export function ComSpirit(options) {
    //timer,css
    var mode = options.mode || 'css';
    return mode === 'css' && supportCss3Property ? css3(options) : keyframe(options)
}
