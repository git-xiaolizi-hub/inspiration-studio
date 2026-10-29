/** 未实现占位错误：M1 只搭骨架，具体能力由后续里程碑补齐 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}
