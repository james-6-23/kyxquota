/**
 * 至尊场系统服务层
 */

import { supremeSlotQueries, weightConfigQueries, rewardConfigQueries, userQueries } from '../database';
import type { SupremeSlotConfig } from '../types';
import logger from '../utils/logger';

/**
 * 获取用户显示名称（优先使用 linux_do_username，否则使用 linux_do_id）
 */
function getUserDisplayName(linuxDoId: string): string {
    const user = userQueries.get.get(linuxDoId);
    if (user?.linux_do_username) {
        return user.linux_do_username;
    }
    return linuxDoId;
}

/**
 * 获取用户至尊令牌信息
 */
export function getSupremeTokens(linuxDoId: string): any {
    try {
        const result = supremeSlotQueries.getTokens.get(linuxDoId);

        if (!result) {
            return {
                linux_do_id: linuxDoId,
                tokens: 0,
                fragments: 0,
                tokens_expires_at: null,
                supreme_mode_until: null,
                created_at: Date.now(),
                updated_at: Date.now()
            };
        }

        return result;
    } catch (error) {
        console.error(`[至尊场] 查询令牌信息失败:`, error);
        return null;
    }
}

/**
 * 获取至尊场配置
 */
export function getSupremeSlotConfig(): any {
    const config = supremeSlotQueries.getConfig.get();

    if (!config) {
        logger.warn('至尊场', '配置未找到，使用默认配置');
        // 返回默认配置
        return {
            id: 1,
            enabled: 1,
            fragments_to_token: 10,
            max_tokens_hold: 3,
            token_valid_hours: 168,
            session_valid_hours: 2,
            min_bet_amount: 500000000,
            max_bet_amount: 5000000000,
            bet_step: 100000000,
            daily_entry_limit: 3,
            daily_token_grant_limit: 1,
            daily_bet_limit: 50000000000,
            weight_config_id: 1,
            reward_scheme_id: 1,
            updated_at: Date.now()
        };
    }

    // 🔥 确保关键字段有默认值
    const safeConfig = {
        ...config,
        token_valid_hours: config.token_valid_hours || 168,
        session_valid_hours: config.session_valid_hours || 2,
        max_tokens_hold: config.max_tokens_hold || 3,
        fragments_to_token: config.fragments_to_token || 10,
        daily_entry_limit: config.daily_entry_limit || 3,
        daily_token_grant_limit: config.daily_token_grant_limit || 1
    };

    logger.debug('至尊场', `配置加载成功 - token_valid_hours: ${safeConfig.token_valid_hours}, max_tokens_hold: ${safeConfig.max_tokens_hold}`);

    return safeConfig;
}

/**
 * 检查并清理过期令牌
 */
export function checkTokenExpiry(linuxDoId: string): void {
    const tokens = getSupremeTokens(linuxDoId);
    if (!tokens) return;

    const now = Date.now();

    // 🔥 只有当令牌有过期时间且已过期时才清理
    // 如果没有设置过期时间(tokens_expires_at为null)，则认为永不过期
    if (tokens.tokens > 0 && tokens.tokens_expires_at) {
        const isExpired = tokens.tokens_expires_at < now;

        logger.debug('至尊场', `检查令牌过期 - 用户: ${linuxDoId}, 令牌数: ${tokens.tokens}, 过期时间: ${new Date(tokens.tokens_expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}, 当前时间: ${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}, 是否过期: ${isExpired}`);

        if (isExpired) {
            // 令牌已过期，清零
            supremeSlotQueries.upsertTokens.run(
                linuxDoId,
                0,  // tokens
                tokens.fragments,
                null,  // tokens_expires_at
                tokens.supreme_mode_until,
                tokens.created_at || now,
                now
            );
            logger.info('至尊场', `用户 ${getUserDisplayName(linuxDoId)} 的令牌已过期并清除 - 过期时间: ${new Date(tokens.tokens_expires_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
        }
    }
}

/**
 * 检查至尊场会话是否过期
 */
export function checkSupremeModeExpiry(linuxDoId: string): void {
    const tokens = getSupremeTokens(linuxDoId);
    if (!tokens || !tokens.supreme_mode_until) return;

    const now = Date.now();

    if (tokens.supreme_mode_until < now) {
        // 会话已过期，退出至尊场
        supremeSlotQueries.exitSupremeMode.run(now, linuxDoId);
        logger.info('至尊场', `用户 ${getUserDisplayName(linuxDoId)} 的至尊场会话已过期`);
    }
}

/**
 * 判断用户是否在至尊场中
 */
export function isInSupremeMode(linuxDoId: string): boolean {
    const tokens = getSupremeTokens(linuxDoId);
    if (!tokens || !tokens.supreme_mode_until) return false;

    const now = Date.now();
    return tokens.supreme_mode_until > now;
}

/**
 * 添加至尊令牌（管理员功能）
 */
export function addSupremeToken(linuxDoId: string, count: number = 1): { success: boolean; message?: string; granted?: number } {
    const tokens = getSupremeTokens(linuxDoId);
    const config = getSupremeSlotConfig();
    const now = Date.now();

    // 检查持有上限
    const currentTokens = tokens?.tokens || 0;
    const maxHold = config.max_tokens_hold || 3;

    if (currentTokens >= maxHold) {
        return {
            success: false,
            message: `用户已达令牌持有上限（${maxHold}个）`
        };
    }

    // 计算实际可发放数量（不超过持有上限）
    const actualGrant = Math.min(count, maxHold - currentTokens);

    // 🔥 计算过期时间（确保有足够长的有效期）
    const validHours = config.token_valid_hours || 168;  // 默认7天
    const expiresAt = now + (validHours * 3600000);

    logger.info('至尊场', `发放令牌 - 用户: ${getUserDisplayName(linuxDoId)}, 有效期: ${validHours}小时, 过期时间: ${new Date(expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);

    supremeSlotQueries.upsertTokens.run(
        linuxDoId,
        currentTokens + actualGrant,
        tokens?.fragments || 0,
        expiresAt,
        tokens?.supreme_mode_until || null,
        tokens?.created_at || now,
        now
    );

    logger.info('至尊场', `管理员发放令牌 - 用户: ${getUserDisplayName(linuxDoId)}, 数量: ${actualGrant}, 当前: ${currentTokens + actualGrant}个, 过期时间: ${new Date(expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);

    return {
        success: true,
        granted: actualGrant,
        message: actualGrant < count ? `已达上限，实际发放${actualGrant}个` : `成功发放${actualGrant}个令牌`
    };
}

/**
 * 添加至尊碎片
 */
export function addSupremeFragment(linuxDoId: string, count: number = 1): void {
    const tokens = getSupremeTokens(linuxDoId);
    const now = Date.now();

    supremeSlotQueries.upsertTokens.run(
        linuxDoId,
        tokens?.tokens || 0,
        (tokens?.fragments || 0) + count,
        tokens?.tokens_expires_at || null,
        tokens?.supreme_mode_until || null,
        tokens?.created_at || now,
        now
    );

    logger.info('至尊场', `用户 ${getUserDisplayName(linuxDoId)} 获得 ${count} 个至尊碎片，当前碎片: ${(tokens?.fragments || 0) + count}`);
}

/**
 * 合成至尊令牌
 */
export async function synthesizeSupremeToken(linuxDoId: string): Promise<{ success: boolean; message: string; data?: any }> {
    checkTokenExpiry(linuxDoId);

    const tokens = getSupremeTokens(linuxDoId);
    const config = getSupremeSlotConfig();

    if (!tokens) {
        return { success: false, message: '获取令牌信息失败' };
    }

    // 检查碎片数量
    if (tokens.fragments < config.fragments_to_token) {
        return {
            success: false,
            message: `碎片不足，需要 ${config.fragments_to_token} 个碎片才能合成`
        };
    }

    // 检查令牌持有上限
    if (tokens.tokens >= config.max_tokens_hold) {
        return {
            success: false,
            message: `已达到令牌持有上限（${config.max_tokens_hold}个）`
        };
    }

    // 检查今日获得限制（使用北京时间）
    const { getTodayDate } = await import('./slot');
    const today = getTodayDate();
    const todayGrant = supremeSlotQueries.getTodayGrant.get(linuxDoId, today);
    const tokensGrantedToday = todayGrant?.tokens_granted || 0;

    if (tokensGrantedToday >= config.daily_token_grant_limit) {
        return {
            success: false,
            message: `今日令牌获得已达上限（${config.daily_token_grant_limit}个）`
        };
    }

    const now = Date.now();
    const expiresAt = now + (config.token_valid_hours * 3600000);

    // 合成令牌（扣除碎片，增加令牌）
    supremeSlotQueries.upsertTokens.run(
        linuxDoId,
        tokens.tokens + 1,
        tokens.fragments - config.fragments_to_token,
        expiresAt,
        tokens.supreme_mode_until,
        tokens.created_at || now,
        now
    );

    // 更新今日获得记录
    supremeSlotQueries.updateTodayGrant.run(
        linuxDoId,
        today,
        1,  // tokens_granted
        0,  // fragments_granted
        now,
        // ON CONFLICT 部分
        1,
        0,
        now
    );

    logger.info('至尊场', `用户 ${getUserDisplayName(linuxDoId)} 合成至尊令牌，当前: ${tokens.tokens + 1}个`);

    return {
        success: true,
        message: `✨ 合成成功！获得1个至尊令牌（剩余碎片: ${tokens.fragments - config.fragments_to_token}）`,
        data: {
            tokens: tokens.tokens + 1,
            fragments: tokens.fragments - config.fragments_to_token
        }
    };
}

/**
 * 进入至尊场（消耗1个至尊令牌）
 */
export async function enterSupremeMode(linuxDoId: string): Promise<{ success: boolean; message: string; validUntil?: number }> {
    // 检查令牌是否过期
    checkTokenExpiry(linuxDoId);

    const tokens = getSupremeTokens(linuxDoId);
    const config = getSupremeSlotConfig();

    if (!tokens || tokens.tokens < 1) {
        logger.debug('至尊场', `进入失败 - 用户: ${linuxDoId}, 令牌不足: ${tokens?.tokens || 0}`);
        return {
            success: false,
            message: '至尊令牌不足，无法进入至尊场'
        };
    }

    if (!config.enabled) {
        logger.debug('至尊场', `进入失败 - 至尊场功能已关闭`);
        return {
            success: false,
            message: '至尊场功能已关闭'
        };
    }

    // 检查每日进入次数限制（使用北京时间）
    const { getTodayDate } = await import('./slot');
    const today = getTodayDate();
    const todayEntry = supremeSlotQueries.getTodayEntry.get(linuxDoId, today);
    const entryCount = todayEntry?.entry_count || 0;

    if (entryCount >= config.daily_entry_limit) {
        logger.debug('至尊场', `进入失败 - 用户: ${linuxDoId}, 今日已进入 ${entryCount} 次，达到限制 ${config.daily_entry_limit}`);
        return {
            success: false,
            message: `今日进入次数已达上限（${config.daily_entry_limit}次）`
        };
    }

    const now = Date.now();
    const validUntil = now + (config.session_valid_hours * 3600000);

    try {
        const result = supremeSlotQueries.useToken.run(validUntil, now, linuxDoId);

        // 验证是否扣除成功
        const afterTokens = getSupremeTokens(linuxDoId);

        if (afterTokens && afterTokens.tokens === tokens.tokens - 1 && afterTokens.supreme_mode_until === validUntil) {
            logger.info('至尊场', `用户 ${getUserDisplayName(linuxDoId)} 成功进入至尊场，有效期至 ${new Date(validUntil).toLocaleString()}`);

            // 更新今日进入记录
            supremeSlotQueries.updateTodayEntry.run(
                linuxDoId,
                today,
                now,
                // ON CONFLICT 部分
                now
            );

            // 🏆 触发成就检查
            try {
                const { checkAndUnlockAchievement, updateAchievementProgress } = await import('./achievement');
                
                // 首次进入至尊场成就
                await checkAndUnlockAchievement(linuxDoId, 'first_supreme');
                
                // 至尊场霸主成就（进入10次）
                await updateAchievementProgress(linuxDoId, 'supreme_10_times', 1);
            } catch (error: any) {
                logger.warn('至尊场', `成就检查失败: ${error.message}`);
            }

            return {
                success: true,
                message: `🏆 成功进入至尊场！会话有效期 ${config.session_valid_hours} 小时`,
                validUntil: validUntil
            };
        } else {
            return {
                success: false,
                message: '进入至尊场失败，请重试'
            };
        }
    } catch (error) {
        console.error(`[至尊场] 进入失败:`, error);
        return {
            success: false,
            message: '进入至尊场失败: ' + (error as Error).message
        };
    }
}

/**
 * 退出至尊场
 */
export function exitSupremeMode(linuxDoId: string): void {
    const now = Date.now();
    supremeSlotQueries.exitSupremeMode.run(now, linuxDoId);
    logger.info('至尊场', `用户 ${getUserDisplayName(linuxDoId)} 退出至尊场`);
}

/**
 * 记录至尊令牌掉落
 */
export function recordSupremeDrop(
    linuxDoId: string,
    username: string,
    dropType: 'token' | 'fragment',
    dropCount: number,
    source: string,
    triggerWinType?: string
): void {
    const now = Date.now();
    const { getTodayDate } = require('./slot');
    const today = getTodayDate();

    supremeSlotQueries.insertDropRecord.run(
        linuxDoId,
        username,
        dropType,
        dropCount,
        source,
        triggerWinType || null,
        now,
        today,
        now
    );

    logger.info('至尊场', `记录掉落 - 用户: ${username}, 类型: ${dropType}, 数量: ${dropCount}, 来源: ${source}`);
}

/**
 * 获取符号权重（根据配置方案ID）
 */
export function getSupremeWeights(): any {
    const config = getSupremeSlotConfig();
    const weightConfig = weightConfigQueries.getById.get(config.weight_config_id);

    if (!weightConfig) {
        logger.warn('至尊场', '权重配置不存在，使用默认值');
        return {
            weight_m: 100,
            weight_t: 100,
            weight_n: 100,
            weight_j: 100,
            weight_lq: 100,
            weight_bj: 100,
            weight_zft: 100,
            weight_bdk: 100,
            weight_lsh: 25
        };
    }

    return weightConfig;
}

/**
 * 获取奖励规则（根据配置方案ID）
 */
export function getSupremeRewardRules(): { rules: any[]; punishments: any[] } {
    const config = getSupremeSlotConfig();
    const rules = rewardConfigQueries.getRulesByScheme.all(config.reward_scheme_id);
    const punishments = rewardConfigQueries.getPunishmentsByScheme.all(config.reward_scheme_id);

    return {
        rules: rules || [],
        punishments: punishments || []
    };
}

/**
 * 生成随机符号（基于权重）
 */
export function generateSupremeSymbols(): string[] {
    const weights = getSupremeWeights();

    const symbolPool: string[] = [];
    symbolPool.push(...Array(weights.weight_m || 0).fill('m'));
    symbolPool.push(...Array(weights.weight_t || 0).fill('t'));
    symbolPool.push(...Array(weights.weight_n || 0).fill('n'));
    symbolPool.push(...Array(weights.weight_j || 0).fill('j'));
    symbolPool.push(...Array(weights.weight_lq || 0).fill('lq'));
    symbolPool.push(...Array(weights.weight_bj || 0).fill('bj'));
    symbolPool.push(...Array(weights.weight_zft || 0).fill('zft'));
    symbolPool.push(...Array(weights.weight_bdk || 0).fill('bdk'));
    symbolPool.push(...Array(weights.weight_lsh || 0).fill('lsh'));
    symbolPool.push(...Array(weights.weight_man || 25).fill('man'));  // 🔥 添加man符号

    const symbols: string[] = [];
    for (let i = 0; i < 4; i++) {
        const randomIndex = Math.floor(Math.random() * symbolPool.length);
        symbols.push(symbolPool[randomIndex]);
    }

    return symbols;
}

/**
 * 判断中奖（根据奖励规则配置）
 */
export function calculateSupremeWin(symbols: string[]): {
    winType: string;
    multiplier: number;
    ruleName: string;
    grantFreeSpin: boolean;
    punishmentCount?: number;
    banHours?: number;
} {
    // 先检查律师函惩罚
    const lshCount = symbols.filter(s => s === 'lsh').length;

    if (lshCount > 0) {
        const { punishments } = getSupremeRewardRules();
        const punishment = punishments.find(p => p.lsh_count === lshCount && p.is_active);

        if (punishment) {
            return {
                winType: 'punishment',
                multiplier: -punishment.deduct_multiplier,
                ruleName: `律师函惩罚×${lshCount}`,
                grantFreeSpin: false,
                punishmentCount: lshCount,
                banHours: punishment.ban_hours
            };
        }
    }

    // 获取奖励规则并按优先级排序
    const { rules } = getSupremeRewardRules();
    const activeRules = rules.filter(r => r.is_active).sort((a, b) => b.priority - a.priority);

    logger.debug('至尊场判定', `符号结果: [${symbols.join(', ')}]`);
    logger.debug('至尊场判定', `激活的规则数量: ${activeRules.length}`);

    // 按优先级检查规则
    for (const rule of activeRules) {
        logger.debug('至尊场判定', `检查规则: ${rule.rule_name} (类型: ${rule.match_pattern}, 数量: ${rule.match_count})`);
        const matched = checkRuleMatch(symbols, rule);

        if (matched) {
            logger.info('至尊场判定', `✅ 匹配规则: ${rule.rule_name}, 倍率: ${rule.win_multiplier}x`);
            return {
                winType: rule.rule_type,
                multiplier: rule.win_multiplier,
                ruleName: rule.rule_name,
                grantFreeSpin: !!rule.grant_free_spin
            };
        }
    }

    logger.debug('至尊场判定', '❌ 未匹配任何规则');
    return {
        winType: 'none',
        multiplier: 0,
        ruleName: '未中奖',
        grantFreeSpin: false
    };
}

/**
 * 检查规则是否匹配
 */
function checkRuleMatch(symbols: string[], rule: any): boolean {
    const pattern = rule.match_pattern;
    const count = rule.match_count;

    // 🔥 处理带数字前缀的模式（如 4-consecutive, 3-any）
    let normalizedPattern = pattern;
    if (pattern.includes('-')) {
        const parts = pattern.split('-');
        normalizedPattern = parts[1]; // 取 "consecutive" 或 "any"
    }

    if (normalizedPattern === 'consecutive') {
        // 严格连续匹配
        return hasConsecutiveMatch(symbols, count);
    } else if (normalizedPattern === 'any') {
        // 任意位置匹配
        return hasAnyMatch(symbols, count);
    } else if (pattern === 'sequence') {
        // 按顺序匹配特定符号
        const requiredSymbols = JSON.parse(rule.required_symbols || '[]');
        return arraysEqual(symbols, requiredSymbols);
    } else if (pattern === 'combination') {
        // 组合匹配（包含所有符号但不按顺序）
        const requiredSymbols = JSON.parse(rule.required_symbols || '[]');
        return containsAll(symbols, requiredSymbols);
    } else if (pattern === 'double_pair') {
        // 两对2连（MMNN格式，排除4连）
        return hasDoublePair(symbols);
    } else if (pattern === 'symmetric') {
        // 对称（前两个和后两个相同：AABB）
        return hasSymmetric(symbols);
    }

    return false;
}

/**
 * 检查是否有连续匹配
 */
function hasConsecutiveMatch(symbols: string[], count: number): boolean {
    // 🔥 调试日志已移除（性能优化）

    for (let i = 0; i <= symbols.length - count; i++) {
        const slice = symbols.slice(i, i + count);
        const isMatch = slice.every(s => s === slice[0]);
        // 🔥 调试日志已移除（性能优化）

        if (isMatch) {
            // logger.debug('至尊场判定', `✅ 找到${count}连: ${slice[0]}`);
            return true;
        }
    }

    // logger.debug('至尊场判定', `❌ 未找到${count}连`);
    return false;
}

/**
 * 检查任意位置是否有足够数量的相同符号
 */
function hasAnyMatch(symbols: string[], count: number): boolean {
    const symbolCounts: { [key: string]: number } = {};

    for (const symbol of symbols) {
        symbolCounts[symbol] = (symbolCounts[symbol] || 0) + 1;
    }

    return Object.values(symbolCounts).some(c => c >= count);
}

/**
 * 检查数组是否完全相等
 */
function arraysEqual(arr1: string[], arr2: string[]): boolean {
    if (arr1.length !== arr2.length) return false;
    return arr1.every((val, index) => val === arr2[index]);
}

/**
 * 检查是否包含所有目标符号
 */
function containsAll(arr: string[], target: string[]): boolean {
    return target.every(t => arr.includes(t));
}

/**
 * 检查是否有两对2连（MMNN格式，排除4连）
 */
function hasDoublePair(symbols: string[]): boolean {
    const pairCounts: Record<string, number> = {};
    symbols.forEach(s => pairCounts[s] = (pairCounts[s] || 0) + 1);

    // 必须恰好有2个不同符号，每个出现2次
    const pairs = Object.values(pairCounts).filter(count => count === 2);
    const matched = pairs.length === 2 && Object.keys(pairCounts).length === 2;

    // logger.debug('至尊场判定', `两对2连检查: 符号计数=${JSON.stringify(pairCounts)}, 2次对数=${pairs.length}, 匹配=${matched}`);
    return matched;
}

/**
 * 检查是否对称（前两个和后两个相同：AABB）
 */
function hasSymmetric(symbols: string[]): boolean {
    if (symbols.length === 4) {
        const matched = symbols[0] === symbols[1] && symbols[2] === symbols[3];
        // logger.debug('至尊场判定', `对称检查: [${symbols[0]},${symbols[1]}] == [${symbols[2]},${symbols[3]}], 匹配=${matched}`);
        return matched;
    }
    return false;
}

/**
 * 记录至尊场游戏
 */
export function recordSupremeGame(
    linuxDoId: string,
    username: string,
    linuxDoUsername: string | null,
    betAmount: number,
    symbols: string[],
    winType: string,
    winMultiplier: number,
    winAmount: number,
    ruleName: string | null = null  // 🔥 新增：规则名称
): void {
    const now = Date.now();
    const { getTodayDate } = require('./slot');
    const today = getTodayDate();

    supremeSlotQueries.insertRecord.run(
        linuxDoId,
        username,
        linuxDoUsername,
        betAmount,
        JSON.stringify(symbols),
        winType,
        winMultiplier,
        winAmount,
        ruleName || null,  // 🔥 记录规则名称
        now,
        today,
        now
    );

    logger.info('至尊场', `记录游戏 - 用户: ${username}, 投注: $${(betAmount / 500000).toFixed(2)}, 赢得: $${(winAmount / 500000).toFixed(2)}, 规则: ${ruleName || winType}, 倍率: ${winMultiplier}x`);
}

/**
 * 获取今日至尊场投注总额
 */
export function getTodaySupremeBet(linuxDoId: string): number {
    const today = new Date().toISOString().split('T')[0];
    const records = supremeSlotQueries.getRecordsByUser.all(linuxDoId);

    const todayRecords = records.filter((r: any) => r.date === today);
    const totalBet = todayRecords.reduce((sum: number, r: any) => sum + r.bet_amount, 0);

    return totalBet;
}

