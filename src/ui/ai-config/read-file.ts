/**
 * 读文本文件：优先 `Blob.text()`，jsdom / 老 Safari 没有时退回 FileReader。
 * （M2 的教训：jsdom 的 Blob 缺 `arrayBuffer()`；`text()` 同样不是处处都有。
 * 产品代码保持标准语义，只在这里加一层兜底。）
 */
export async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsText(file);
  });
}
