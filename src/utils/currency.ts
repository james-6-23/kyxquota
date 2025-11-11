// ========== KYX 钱包系统 - 货币换算工具 ==========

/**
 * 货币单位换算常量
 */
export const CURRENCY = {
    // 汇率
    EXCHANGE_RATE: 2.5,           // 1$ = 2.5 KYX

    // quota 单位
    QUOTA_PER_USD: 500000,        // 1$ = 500,000 quota
    QUOTA_PER_KYX: 200000,        // 1 KYX = 200,000 quota

    // 反向换算
    USD_PER_KYX: 0.4,             // 1 KYX = $0.4
    KYX_PER_USD: 2.5,             // 1$ = 2.5 KYX
} as const;

// ========== $ ↔ KYX 换算 ==========

/**
 * $ → KYX
 * @param usd 美元金额
 * @returns KYX 金额（整数）
 *
 * @example
 * usdToKYX(40)  // → 100 KYX
 * usdToKYX(100) // → 250 KYX
 */
export function usdToKYX(usd: number): number {
    return Math.floor(usd * CURRENCY.KYX_PER_USD);
}

/**
 * KYX → $
 * @param kyx KYX 金额
 * @returns 美元金额（整数）
 *
 * @example
 * kyxToUSD(100) // → 40 $
 * kyxToUSD(250) // → 100 $
 */
export function kyxToUSD(kyx: number): number {
    return Math.floor(kyx * CURRENCY.USD_PER_KYX);
}

// ========== quota ↔ KYX 换算 ==========

/**
 * quota → KYX
 * @param quota quota 金额
 * @returns KYX 金额（整数）
 *
 * @example
 * quotaToKYX(20000000) // → 100 KYX (相当于 $40)
 * quotaToKYX(50000000) // → 250 KYX (相当于 $100)
 */
export function quotaToKYX(quota: number): number {
    return Math.floor(quota / CURRENCY.QUOTA_PER_KYX);
}

/**
 * KYX → quota
 * @param kyx KYX 金额
 * @returns quota 金额（整数）
 *
 * @example
 * kyxToQuota(100) // → 20,000,000 quota (相当于 $40)
 * kyxToQuota(250) // → 50,000,000 quota (相当于 $100)
 */
export function kyxToQuota(kyx: number): number {
    return kyx * CURRENCY.QUOTA_PER_KYX;
}

// ========== quota ↔ $ 换算（原有逻辑保留） ==========

/**
 * quota → $
 * @param quota quota 金额
 * @returns 美元金额（保留2位小数）
 *
 * @example
 * quotaToUSD(20000000) // → 40.00 $
 * quotaToUSD(50000000) // → 100.00 $
 */
export function quotaToUSD(quota: number): number {
    return quota / CURRENCY.QUOTA_PER_USD;
}

/**
 * $ → quota
 * @param usd 美元金额
 * @returns quota 金额（整数）
 *
 * @example
 * usdToQuota(40)  // → 20,000,000 quota
 * usdToQuota(100) // → 50,000,000 quota
 */
export function usdToQuota(usd: number): number {
    return Math.floor(usd * CURRENCY.QUOTA_PER_USD);
}

// ========== 格式化显示 ==========

/**
 * 格式化 KYX 显示
 * @param kyx KYX 金额
 * @returns 格式化字符串
 *
 * @example
 * formatKYX(1250) // → "1,250 KYX"
 * formatKYX(100)  // → "100 KYX"
 */
export function formatKYX(kyx: number): string {
    return `${kyx.toLocaleString()} KYX`;
}

/**
 * 格式化 $ 显示
 * @param usd 美元金额
 * @returns 格式化字符串
 *
 * @example
 * formatUSD(40.5)  // → "$40.50"
 * formatUSD(100)   // → "$100.00"
 */
export function formatUSD(usd: number): string {
    return `$${usd.toFixed(2)}`;
}

/**
 * 格式化 quota 显示（转为 $ 显示）
 * @param quota quota 金额
 * @returns 格式化字符串
 *
 * @example
 * formatQuota(20000000) // → "$40.00"
 * formatQuota(50000000) // → "$100.00"
 */
export function formatQuota(quota: number): string {
    return formatUSD(quotaToUSD(quota));
}

/**
 * 格式化 KYX 和等值 $ 显示
 * @param kyx KYX 金额
 * @returns 格式化字符串
 *
 * @example
 * formatKYXWithUSD(100) // → "100 KYX (≈ $40.00)"
 * formatKYXWithUSD(250) // → "250 KYX (≈ $100.00)"
 */
export function formatKYXWithUSD(kyx: number): string {
    const usd = kyxToUSD(kyx);
    return `${formatKYX(kyx)} (≈ ${formatUSD(usd)})`;
}

// ========== 验证和限制 ==========

/**
 * 验证 KYX 金额是否有效
 * @param kyx KYX 金额
 * @returns 是否有效
 */
export function isValidKYX(kyx: number): boolean {
    return Number.isInteger(kyx) && kyx > 0;
}

/**
 * 验证 $ 金额是否可转换为整数 KYX
 * @param usd 美元金额
 * @returns 是否可以完整转换
 *
 * @example
 * isConvertibleToKYX(40)   // → true  (40 * 2.5 = 100 KYX)
 * isConvertibleToKYX(40.5) // → false (40.5 * 2.5 = 101.25 KYX，有小数)
 */
export function isConvertibleToKYX(usd: number): boolean {
    const kyx = usd * CURRENCY.KYX_PER_USD;
    return Number.isInteger(kyx);
}

/**
 * 调整金额到最接近的可转换值
 * @param usd 美元金额
 * @returns 调整后的美元金额
 *
 * @example
 * adjustToConvertible(40.3) // → 40 (可转换为 100 KYX)
 * adjustToConvertible(41.5) // → 42 (可转换为 105 KYX)
 */
export function adjustToConvertible(usd: number): number {
    const kyx = Math.round(usd * CURRENCY.KYX_PER_USD);
    return kyxToUSD(kyx);
}

// ========== 批量换算 ==========

/**
 * 批量换算 quota → KYX
 * @param quotas quota 数组
 * @returns KYX 数组
 */
export function batchQuotaToKYX(quotas: number[]): number[] {
    return quotas.map(quotaToKYX);
}

/**
 * 批量换算 KYX → quota
 * @param kyxAmounts KYX 数组
 * @returns quota 数组
 */
export function batchKYXToQuota(kyxAmounts: number[]): number[] {
    return kyxAmounts.map(kyxToQuota);
}

// ========== 常用金额常量 ==========

/**
 * 常用 KYX 金额
 */
export const COMMON_KYX = {
    DAILY_CLAIM: usdToKYX(40),      // 100 KYX - 每日领取
    BINDING_BONUS: usdToKYX(100),   // 250 KYX - 绑定奖励
    KEY_REWARD: usdToKYX(50),       // 125 KYX - 投喂 Key
    MIN_GAME: usdToKYX(10),         // 25 KYX - 游戏最低额度
    MIN_TRANSFER: usdToKYX(10),     // 25 KYX - 最小划转
} as const;

/**
 * 常用 quota 金额
 */
export const COMMON_QUOTA = {
    DAILY_CLAIM: 20000000,      // $40
    BINDING_BONUS: 50000000,    // $100
    KEY_REWARD: 25000000,       // $50
    MIN_GAME: 5000000,          // $10
} as const;

// ========== 使用示例 ==========

/*
// 基础换算
const kyx = usdToKYX(40);        // 100 KYX
const usd = kyxToUSD(100);       // 40 $
const quota = kyxToQuota(100);   // 20,000,000 quota

// quota 换算
const kyx2 = quotaToKYX(20000000);  // 100 KYX
const quota2 = kyxToQuota(100);     // 20,000,000 quota

// 格式化显示
console.log(formatKYX(100));              // "100 KYX"
console.log(formatUSD(40));               // "$40.00"
console.log(formatKYXWithUSD(100));       // "100 KYX (≈ $40.00)"
console.log(formatQuota(20000000));       // "$40.00"

// 验证
console.log(isValidKYX(100));             // true
console.log(isConvertibleToKYX(40));      // true
console.log(isConvertibleToKYX(40.5));    // false

// 常用金额
console.log(COMMON_KYX.DAILY_CLAIM);      // 100 KYX
console.log(COMMON_KYX.BINDING_BONUS);    // 250 KYX
*/
