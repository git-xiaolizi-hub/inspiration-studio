import { describe, expect, it } from 'vitest';
import { buildDraftFinalizePayload, buildTaskPayload } from './payload';
import { ARK_MODEL_ID, PRICE_TABLE_MODEL_NAME } from './constants';
import { isVideoError } from './errors';
import { estimateVideoRequest } from './estimate';
import { OFFICIAL_PRICE_TABLE } from '../ai-models/pricing';
import type { VideoGenerationRequest } from './types';

const options = { model: ARK_MODEL_ID };

function request(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    prompt: '一只猫在雨里走',
    params: { duration: 5, resolution: '720p', ratio: 'adaptive' },
    ...overrides,
  };
}

describe('请求体形状：只发任务书 §3 确认过的字段', () => {
  it('文生视频：只有 text + 四个顶层参数，不夹带未确认字段', () => {
    const payload = buildTaskPayload(request(), options);
    expect(payload.model).toBe('doubao-seedance-2-5-260628');
    expect(payload.content).toEqual([{ type: 'text', text: '一只猫在雨里走' }]);
    expect(payload.ratio).toBe('adaptive');
    expect(payload.duration).toBe(5);
    expect(payload.resolution).toBe('720p');
    expect(payload.draft).toBe(false);
    expect(payload.watermark).toBe(false);
    expect(payload.generate_audio).toBe(true);
    expect(payload.omni_reference_task_type).toBeUndefined();
    // 未确认的字段（output_format / service_tier 等）一个都不许出现
    expect(Object.keys(payload).sort()).toEqual(
      ['content', 'draft', 'duration', 'generate_audio', 'model', 'ratio', 'resolution', 'watermark'].sort(),
    );
  });

  it('参考图 → role=reference_image；首尾帧 → first_frame / last_frame；参考视频 → reference_video', () => {
    const payload = buildTaskPayload(
      request({
        references: {
          images: [{ url: 'https://cdn.example.com/a.png', role: 'character' }],
          videos: [{ url: 'https://cdn.example.com/b.mp4', role: 'editing_target' }],
        },
        keyframes: [
          { position: 'first', image_url: 'https://cdn.example.com/f.png' },
          { position: 'last', image_url: 'https://cdn.example.com/l.png' },
        ],
      }),
      options,
    );

    const roles = payload.content.map((item) => item.role ?? item.type);
    expect(roles).toEqual(['text', 'reference_image', 'first_frame', 'last_frame', 'reference_video']);
    expect(payload.content[1].image_url?.url).toBe('https://cdn.example.com/a.png');
    expect(payload.content[4].video_url?.url).toBe('https://cdn.example.com/b.mp4');
    // 有参考视频（编辑类任务）才带 auto
    expect(payload.omni_reference_task_type).toBe('auto');
  });

  it('样片模式：draft=true 且分辨率被钉成 480p（官方只支持 480p）', () => {
    const payload = buildTaskPayload(
      request({ params: { duration: 5, resolution: '1080p', ratio: '16:9', draft_mode: true } }),
      options,
    );
    expect(payload.draft).toBe(true);
    expect(payload.resolution).toBe('480p');
  });

  it('base64 data URL 可以进 image_url（小图内联），但视频不行', () => {
    const dataUrl = 'data:image/png;base64,aGk=';
    const payload = buildTaskPayload(
      request({ references: { images: [{ url: dataUrl, role: 'style' }] } }),
      options,
    );
    expect(payload.content[1].image_url?.url).toBe(dataUrl);

    expect(() =>
      buildTaskPayload(
        request({ references: { videos: [{ url: dataUrl, role: 'motion' }] } }),
        options,
      ),
    ).toThrowError(/视频不能走 base64/);
  });

  it('时长非法在本地就拦（不发请求）', () => {
    try {
      buildTaskPayload(request({ params: { duration: 3, resolution: '720p', ratio: 'adaptive' } }), options);
      throw new Error('应当抛错');
    } catch (error) {
      expect(isVideoError(error) && error.category).toBe('duration_conflict');
      expect(isVideoError(error) && error.message).toContain('4–30');
    }
  });

  it('第 n 个关键帧无法映射 → 明确报"未验证"，不瞎猜 role', () => {
    expect(() =>
      buildTaskPayload(
        request({ keyframes: [{ position: 2, image_url: 'https://cdn.example.com/k.png' }] }),
        options,
      ),
    ).toThrowError(/无法映射/);
  });

  it('提示词为空且没有素材 → 报错（不去打服务端）', () => {
    expect(() => buildTaskPayload(request({ prompt: '   ' }), options)).toThrowError(/提示词为空/);
  });

  it('音频按 content.audio_url 传（形状未验证，已在报告标注）', () => {
    const payload = buildTaskPayload(
      request({ references: { audio: [{ url: 'https://cdn.example.com/a.mp3' }] } }),
      options,
    );
    const audio = payload.content.find((item) => item.type === 'audio_url');
    expect(audio?.audio_url?.url).toBe('https://cdn.example.com/a.mp3');
  });
});

describe('样片第二步（官方文档确认：content 里放 draft_task，分辨率只能 1080p）', () => {
  it('不出现在第一步的字段（提示词/参考素材由服务端复用）', () => {
    const payload = buildDraftFinalizePayload('draft-task-1', options);
    expect(payload.content).toEqual([{ type: 'draft_task', draft_task: { id: 'draft-task-1' } }]);
    expect(payload.resolution).toBe('1080p');
    expect(payload.draft).toBe(false);
    expect(payload.ratio).toBeUndefined();
    expect(payload.duration).toBeUndefined();
  });
});

describe('预估桥接（复用 M3 公式，不重写）', () => {
  it('非样片：720p/5 秒 = ¥7.56（648000/30×5 = 108000 token × ¥70/M）', () => {
    const built = estimateVideoRequest({
      request: request(),
      priceTable: OFFICIAL_PRICE_TABLE,
      priceModel: PRICE_TABLE_MODEL_NAME,
    });
    expect(built.estimate.items[0].tokens).toBe(108_000);
    expect(built.estimate.total).toBeCloseTo(7.56, 2);
    expect(built.lines).toBeNull();
  });

  it('样片模式：把成片分辨率钉成 1080p 并给出提示', () => {
    const built = estimateVideoRequest({
      request: request({ params: { duration: 5, resolution: '720p', ratio: 'adaptive', draft_mode: true } }),
      priceTable: OFFICIAL_PRICE_TABLE,
      priceModel: PRICE_TABLE_MODEL_NAME,
    });
    expect(built.effectiveResolution).toBe('1080p');
    expect(built.lines?.draft).toContain('480p');
    expect(built.lines?.final).toContain('1080p');
    expect(built.notices.join(' ')).toContain('只能 1080p');
  });

  it('有输入视频时必带最低用量提示（官方门槛）', () => {
    const built = estimateVideoRequest({
      request: request(),
      priceTable: OFFICIAL_PRICE_TABLE,
      priceModel: PRICE_TABLE_MODEL_NAME,
      inVideoSec: 6,
    });
    expect(built.estimate.hasInputVideo).toBe(true);
    expect(built.notices.join(' ')).toContain('最低 token 用量');
  });
});
