/**
 * P5 §7：示例卡片 —— 「载入一组示例」（首页空态）。
 *
 * 委托人的要求是**主次关系要能看见**：一进来三条孤立记录，用户根本不知道
 * 「成品」和「素材」是什么关系。所以示例特意做成一条链：
 *
 * ```
 * 1 笔记   「凌晨三点的梦…」                      role=note
 * 2 AI产出 「解梦：图书馆象征…」                  role=asset  sourceIds=[1]
 * 3 成品   「图书馆在呼吸。不是比喻…」            role=draft  sourceIds=[1,2]
 * ```
 *
 * 三条都是**真记录**（写进 records 表），不是界面上摆的假数据：能编辑、能删、能置顶、
 * 能进合集、能被备份带走。用户改坏了也不会有任何东西失效。
 *
 * **幂等**：id 固定（`SAMPLE_RECORD_IDS`），用 `putRecord` 覆盖写。
 * 连点两次不会变成 6 条；先删掉示例再点一次，回来还是这 3 条（同一个 id，
 * 因此引用它们的合集 / 置顶也不会指向空 id）。
 */
import { getRecord, putRecord } from '../storage';
import type { RecordRow } from '../storage/db';
import type { RecordEntity } from './types';

/** 固定的三个 id：改这里等于换一套示例，旧的那套会变成孤儿记录（别随意改） */
export const SAMPLE_RECORD_IDS = {
  note: 'p5-sample-note',
  asset: 'p5-sample-asset',
  draft: 'p5-sample-draft',
} as const;

/** 示例正文（任务书 §7.2 逐字） */
const SAMPLE_TEXTS = {
  note: '凌晨三点的梦：一座会呼吸的图书馆，书页像潮水一样翻动。',
  asset: '解梦：图书馆象征被压抑的记忆。书页翻动是那些还没被说出口的话，潮水是情绪的周期。',
  draft: '图书馆在呼吸。不是比喻——书页真的在起伏，像退潮后还留在沙上的水。',
} as const;

export interface ExampleResult {
  /** 写进库的三条（顺序 = 笔记 → AI 产出 → 成品） */
  records: RecordEntity[];
  /** 之前已经载入过（这次是覆盖）时为 true */
  overwritten: boolean;
}

function sampleRow(
  id: string,
  text: string,
  createdAt: number,
  extra: Partial<RecordRow>,
): RecordRow {
  return { id, text, tags: [], createdAt, updatedAt: createdAt, ...extra };
}

/**
 * 载入（或覆盖）三条示例。
 *
 * `now` 可注入：测试要断言「第二次点击不新增」，也让排序稳定。
 * 三条时间戳彼此错开 1 秒，保证「成品」在列表最上面（`createdAt` 倒序）。
 *
 * 走 `putRecord`（通用 CRUD，带配额预检）而不是 `createRecord`：`createRecord` 自己
 * 生成 id，而**固定 id 才是幂等的实现方式**（第二次是覆盖同一条，不是新增一条）。
 */
export async function loadExampleRecords(now = Date.now()): Promise<ExampleResult> {
  const existing = await getRecord<RecordRow>('records', SAMPLE_RECORD_IDS.draft);
  const overwritten = Boolean(existing);

  const rows: RecordRow[] = [
    sampleRow(SAMPLE_RECORD_IDS.note, SAMPLE_TEXTS.note, now - 2000, { tags: ['梦'] }),
    sampleRow(SAMPLE_RECORD_IDS.asset, SAMPLE_TEXTS.asset, now - 1000, {
      tags: ['解梦'],
      role: 'asset',
      sourceIds: [SAMPLE_RECORD_IDS.note],
    }),
    sampleRow(SAMPLE_RECORD_IDS.draft, SAMPLE_TEXTS.draft, now, {
      role: 'draft',
      sourceIds: [SAMPLE_RECORD_IDS.note, SAMPLE_RECORD_IDS.asset],
    }),
  ];

  for (const row of rows) await putRecord('records', row);

  return {
    overwritten,
    records: rows.map((row) => ({
      id: row.id,
      text: row.text,
      tags: row.tags,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.role ? { role: row.role } : {}),
      ...(row.sourceIds ? { sourceIds: row.sourceIds } : {}),
    })),
  };
}

/** 三个示例 id（测试与诊断用；「删除示例」= 现有删记录能力，不额外造入口） */
export function sampleRecordIdList(): string[] {
  return [SAMPLE_RECORD_IDS.note, SAMPLE_RECORD_IDS.asset, SAMPLE_RECORD_IDS.draft];
}
