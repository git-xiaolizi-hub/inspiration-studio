/** 测试用的小工具：jsdom 的 Blob 没有 arrayBuffer()，用 FileReader 兜底读字节 */

export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 读取失败'));
    reader.readAsArrayBuffer(blob);
  });
}

/** 造一个"音频"Blob：内容是可预测的字节，便于导入导出后逐字节比对 */
export function makeAudioBlob(
  bytes: number[] = [1, 2, 3, 4, 5, 6, 7, 8],
  mimeType = 'audio/webm;codecs=opus',
): Blob {
  return new Blob([new Uint8Array(bytes)], { type: mimeType });
}

export function bytesEqual(actual: Uint8Array, expected: number[]): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((value, index) => actual[index] === value);
}
