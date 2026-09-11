/**
 * 把失败响应翻译成可以直接显示给人看的中文。
 *
 * 路由用 `{ error }` 报错，但网关、超时、HTML 错误页都可能返回不是 JSON 的体，
 * 所以解析失败要退回状态码，绝不能让界面上出现一句 JSON 解析异常。
 */
export async function responseErrorText(response: Response) {
  try {
    return (
      ((await response.json()) as { error?: string }).error ??
      `请求失败（${response.status}）`
    );
  } catch {
    return `请求失败（${response.status}）`;
  }
}
