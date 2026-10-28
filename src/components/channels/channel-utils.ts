import type { ChannelConfig } from '../../../shared/types';

export function validateConfig(config: ChannelConfig, panel: string): ChannelConfig {
  const next: ChannelConfig = JSON.parse(JSON.stringify(config));
  if (panel === "aliases") {
    next.aliases = next.aliases.map((alias) => ({
      from: alias.from.trim(),
      to: alias.to.trim(),
    }));
    if (next.aliases.some((alias) => !alias.from || !alias.to))
      throw new Error("请填写每条别名的请求模型和上游模型");
    if (
      new Set(next.aliases.map((alias) => alias.from)).size !==
      next.aliases.length
    )
      throw new Error("请求模型名称不能重复");
  }
  if (panel === "prices") {
    next.prices = next.prices.map((price) => ({
      ...price,
      model: price.model.trim(),
    }));
    if (
      next.prices.some(
        (price) =>
          !price.model ||
          !Number.isFinite(price.input) ||
          price.input < 0 ||
          price.input > 1e6 ||
          !Number.isFinite(price.output) ||
          price.output < 0 ||
          price.output > 1e6,
      )
    ) {
      throw new Error("请填写模型名称，输入和输出价格须在 0–1,000,000 之间");
    }
    if (
      new Set(next.prices.map((price) => price.model)).size !==
      next.prices.length
    )
      throw new Error("同一模型只能设置一条价格");
  }
  if (panel === "rateLimit") {
    if (
      !Number.isInteger(next.rateLimit.requestsPerMinute) ||
      next.rateLimit.requestsPerMinute < 0 ||
      next.rateLimit.requestsPerMinute > 1e6 ||
      !Number.isInteger(next.rateLimit.tokensPerMinute) ||
      next.rateLimit.tokensPerMinute < 0 ||
      next.rateLimit.tokensPerMinute > 1e9
    ) {
      throw new Error("请求和 token 限额须为有效的非负整数");
    }
  }
  if (panel === "endpoints") {
    for (const path of Object.values(next.endpoints)) {
      if (
        !path.startsWith("/") ||
        path.startsWith("//") ||
        /[?#\r\n]/.test(path)
      )
        throw new Error("端点须为以 / 开头的相对路径，不能包含查询参数或片段");
    }
  }
  if (panel === "relay" && next.relayUrl.trim()) {
    let relay: URL;
    try {
      relay = new URL(next.relayUrl.trim());
    } catch {
      throw new Error("请填写有效的 HTTPS 中继地址");
    }
    if (
      relay.protocol !== "https:" ||
      relay.username ||
      relay.password ||
      relay.search ||
      relay.hash
    ) {
      throw new Error("中继地址须为 HTTPS，不能包含登录信息、查询参数或片段");
    }
    next.relayUrl = next.relayUrl.trim();
  }
  if (panel === "autoDisable") {
    const rule = next.autoDisable;
    if (
      rule.statuses.some(
        (status) => !Number.isInteger(status) || status < 400 || status > 599,
      )
    )
      throw new Error("触发状态码须为 400–599");
    if (
      !Number.isInteger(rule.threshold) ||
      rule.threshold < 1 ||
      rule.threshold > 100
    )
      throw new Error("连续错误次数须为 1–100 的整数");
    if (
      !Number.isFinite(rule.cooldown) ||
      rule.cooldown < 1 ||
      rule.cooldown > 86400
    )
      throw new Error("恢复冷却须为 1–86400 秒");
  }
  return next;
}

export type OverrideRow = {
  id: string;
  key: string;
  type: "string" | "number" | "boolean" | "json" | "null";
  value: string;
};
const sensitiveHeaderName =
  /(authorization|api[-_]?key|token|secret|password|cookie|host|content-length|connection|transfer-encoding)/i;
const sensitiveValue = /Bearer\s|(?:sk-|AIza|pg_live_)[A-Za-z0-9_-]{12,}/i;
const protectedBody = new Set([
  "model",
  "stream",
  "messages",
  "contents",
  "system",
  "systemInstruction",
]);
function containsCredential(value: unknown): boolean {
  if (typeof value === "string") return sensitiveValue.test(value);
  if (Array.isArray(value)) return value.some(containsCredential);
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, val]) =>
        /^(?:api[-_]?key|access[-_]?token|token|secret|password|authorization)$/i.test(
          key,
        ) || containsCredential(val),
    );
  return false;
}
function containsNonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (value && typeof value === "object")
    return Object.values(value).some(containsNonFinite);
  return false;
}

export function overridesToRows(
  record: Record<string, unknown>,
  headers = false,
): OverrideRow[] {
  return Object.entries(record).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    type:
      headers || typeof value === "string"
        ? "string"
        : value === null
          ? "null"
          : typeof value === "number"
            ? "number"
            : typeof value === "boolean"
              ? "boolean"
              : "json",
    value:
      typeof value === "string"
        ? value
        : value === null
          ? ""
          : typeof value === "number" || typeof value === "boolean"
            ? String(value)
            : JSON.stringify(value, null, 2),
  }));
}

function parseOverrideRow(row: OverrideRow, headers: boolean): unknown {
  if (!row.key.trim()) throw new Error("请填写键名，或删除此行");
  if (headers) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(row.key))
      throw new Error("请求头名称包含无效字符");
    if (sensitiveHeaderName.test(row.key))
      throw new Error("认证和传输头由网关管理，请使用密钥管理");
    if (row.value.length > 2048 || /[\r\n]/.test(row.value))
      throw new Error("请求头值须为单行文本，最长 2048 字符");
    if (sensitiveValue.test(row.value))
      throw new Error("凭证请保存在密钥管理中");
    return row.value;
  }
  if (protectedBody.has(row.key)) throw new Error("该参数由网关管理，不能覆盖");
  let value: unknown;
  switch (row.type) {
    case "string":
      value = row.value;
      break;
    case "number":
      if (
        !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(row.value.trim()) ||
        !Number.isFinite(Number(row.value))
      )
        throw new Error("请填写有效数值");
      value = Number(row.value);
      break;
    case "boolean":
      if (row.value !== "true" && row.value !== "false")
        throw new Error("请选择 true 或 false");
      value = row.value === "true";
      break;
    case "null":
      value = null;
      break;
    case "json":
      try {
        value = JSON.parse(row.value);
      } catch {
        throw new Error("JSON 格式有误，请检查此参数值");
      }
      break;
    default:
      throw new Error("请选择有效参数类型");
  }
  if (containsNonFinite(value)) throw new Error("参数值包含超出范围的数值");
  if (containsCredential({ [row.key]: value }))
    throw new Error("请求参数不能包含凭证，请使用密钥管理");
  return value;
}

export function serializeOverrides(
  rows: OverrideRow[],
  headers = false,
): Record<string, unknown> {
  const keys = new Set<string>();
  const entries = rows.map((row, index) => {
    const key = headers ? row.key.toLowerCase() : row.key;
    if (keys.has(key))
      throw new Error(
        `${headers ? "请求头" : "请求参数"}第 ${index + 1} 行：键名重复`,
      );
    keys.add(key);
    try {
      return [row.key, parseOverrideRow(row, headers)] as const;
    } catch (error) {
      throw new Error(
        `${headers ? "请求头" : "请求参数"}第 ${index + 1} 行：${error instanceof Error ? error.message : "格式无效"}`,
      );
    }
  });
  const result = Object.fromEntries(entries);
  if (headers && rows.length > 30) throw new Error("自定义请求头最多 30 条");
  if (!headers && JSON.stringify(result).length > 32000)
    throw new Error("请求参数配置不能超过 32,000 字符");
  return result;
}
