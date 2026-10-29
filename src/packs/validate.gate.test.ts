/* 承接方复核时补的「闸门测试」：锁定校验器两端——
   ① 该抓的错必须抓到（不能是摆设）；
   ② 完全合规的样例必须零问题（不能是死门，严到没人能过反而更糟）。
   改动校验规则时必须让这个文件继续通过。 */
import { describe, expect, it } from 'vitest';
import {
  checkEmptyWords,
  checkKeyframePairing,
  checkParamSeparation,
  checkPromptLength,
  checkSymbolPairs,
  validateStoryboard,
} from './validate';

const LONG = '镜头缓慢推进人物走在深夜街道上'.repeat(20);

const P1 =
  '中景跟拍，⟨锚点A⟩推开便利店玻璃门走进店内，门上挂铃晃动<门铃叮当>，冷白顶灯把他的影子压在浅灰瓷砖上，' +
  '背景里冷柜压缩机发出低鸣(低沉的电流嗡鸣)，他抖了一下肩头湿透的外套下摆，水珠甩在地面留下几个深色圆点，' +
  '湿帆布鞋在浅灰瓷砖上蹭出半个脚印，镜头贴着他右后方随他推进到货架深处，最里侧那根灯管轻微频闪，' +
  '他低声说{「还是老样子」}，画面右下角浮出【深夜十一点】。';

const P2 =
  '近景，从⟨锚点A⟩的半身侧后景起，手持跟随他两步走到立式冷柜前，边走边下沉，最后停在手与罐子之间成特写，' +
  '冷柜内的冷白光从下方打亮手背，货架侧壁的暖黄价签灯从右后方补一道细窄边光<冷柜门吸合>，' +
  '他右手伸进冷柜，四指扣住一罐银色易拉罐，指尖在拉环上方停半秒，指节泛白，罐壁细密冷凝水被抹开一道水痕，' +
  '袖口磨毛的棉线在光里发亮(极轻的呼吸声)，背景⟨锚点B⟩只入画到肩线与低下的头顶。';

const SOP =
  '镜头 1 用 opening，不依赖上一帧；镜头 2 与镜头 1 共享帧硬接：取镜头 1 渲染出的真实末帧作为镜头 2 的首帧输入，' +
  '真实末帧不等于规划末帧，模型落点会漂，若构图有出入以真实帧为准微调该镜提示词后重跑该镜，不重跑整链。' +
  '共享帧时逐条比对五处不变量：机位高度、道具位置与朝向、光源方向与色温交界线、湿痕形状、人物肩线角度。' +
  '若镜头 2 忽略了首帧姿态，就在提示词里用文字复述首帧内容再重跑。';

describe('校验器：能抓错 + 合规能过', () => {
  it('超长提示词被抓', () => {
    expect(checkPromptLength(LONG, '镜头1')[0]?.code).toBe('prompt-length');
  });

  it('参数污染被抓', () => {
    for (const bad of ['画面 1080p 输出', '以 24fps 拍摄', '这是一段 15 秒的视频']) {
      expect(checkParamSeparation(bad, '镜头1').length, bad).toBeGreaterThan(0);
    }
  });

  it('空词被抓', () => {
    expect(checkEmptyWords('整片充满电影感，氛围感拉满', '镜头1').length).toBeGreaterThanOrEqual(2);
  });

  it('关键帧数不对被抓', () => {
    const issues = checkKeyframePairing([{ id: 'k1' }, { id: 'k2' }], [{}, {}, {}]);
    expect(issues.some((i) => i.code.startsWith('keyframe'))).toBe(true);
  });

  it('符号未配对 / 全角括号被抓', () => {
    expect(checkSymbolPairs('<雨声没有闭合', 'x').length).toBeGreaterThan(0);
    expect(checkSymbolPairs('（低沉的钢琴）', 'x').some((i) => i.message.includes('半角'))).toBe(true);
  });

  it('空对象 / null 被抓', () => {
    expect(validateStoryboard({}).length).toBeGreaterThan(0);
    expect(validateStoryboard(null).length).toBeGreaterThan(0);
  });

  it('【反向】完全合规的样例必须零问题（否则就是死门）', () => {
    const compliant = {
      anchors: [
        {
          id: '锚点A',
          kind: 'character',
          text: '二十八岁东亚男性，短发微乱，旧深灰连帽卫衣袖口磨白，右腕戴银灰电子表、表带尚新',
        },
        {
          id: '锚点B',
          kind: 'scene',
          text: '深夜便利店室内，冷白顶灯，最里侧灯管轻微频闪，浅灰瓷砖地面反光，蓝白货架',
        },
      ],
      keyframes: [
        { id: 'k1', description: '门外街道，玻璃门透出冷白光，他一手扶门把，雨夜街道湿亮' },
        { id: 'k2', description: '门内两步处，背影走向货架深处，门在身后合拢，灯管频闪' },
        { id: 'k3', description: '冷柜前侧身，手推柜门，玻璃上映出他疲惫的侧脸，冷白光从柜内溢出' },
      ],
      shots: [
        {
          index: 1,
          first_keyframe: 'k1',
          last_keyframe: 'k2',
          prompt: P1,
          continuity: { type: 'opening' },
          shared_invariants: [],
        },
        {
          index: 2,
          first_keyframe: 'k2',
          last_keyframe: 'k3',
          prompt: P2,
          continuity: { type: 'shared_frame' },
          shared_invariants: ['机位高度', '道具位置与朝向', '光源方向与色温交界线'],
        },
      ],
      continuity_sop: SOP,
      params: {
        aspect: '9:16',
        width: 1080,
        height: 1920,
        fps: 24,
        total_seconds: 6,
        shot_seconds: [3, 3],
        audio: '环境声开，无配乐，台词一句',
        subtitles: '',
        references: '锚点A 头像1张+全身1张；锚点B 场景1张',
        tier: '先 480p 样片，确认后出成片',
      },
    };
    const issues = validateStoryboard(compliant);
    console.log('[compliant-issues]', JSON.stringify(issues, null, 1));
    console.log('[word counts]', P1.length, P2.length);
    expect(issues.map((i) => `${i.code}:${i.message}`)).toEqual([]);
  });
});
