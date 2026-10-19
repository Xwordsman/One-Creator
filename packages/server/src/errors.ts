export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}
export function notFound(message = '没有找到这条记录') {
  return new AppError(404, 'NOT_FOUND', message);
}
export function conflict(message = '内容已在其他位置更新，请比较最新版本后再保存') {
  return new AppError(409, 'CONFLICT', message);
}
