/**
 * 基于配置方案的中奖判定系统
 * 用于初级场、高级场、至尊场统一使用配置方案进行中奖判定
 */

import { rewardConfigQueries } from '../database';

/**
 * 根据奖励配置方案判定中奖
 * @param symbols 符号数组
 * @param schemeId 奖励配置方案ID
 * @param isStrictConsecutive 是否严格连续判定（高级场为true，初级场为false）
 */
export function calculateWinByScheme(
    symbols: string[],
    schemeId: number,
    isStrictConsecutive: boolean = false
): {
    winType: string;
    multiplier: number;
    ruleName: string;
    grantFreeSpin: boolean;
    punishmentCount?: number;
    banHours?: number;
} {
    // 1. 先检查律师函惩罚
    const lshCount = symbols.filter(s => s === 'lsh').length;

    if (lshCount > 0) {
        const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);
        const activePunishment = punishments.find(p => p.lsh_count === lshCount && p.is_active);

        if (activePunishment) {
            return {
                winType: 'punishment',
                multiplier: -activePunishment.deduct_multiplier,
                ruleName: `律师函惩罚×${lshCount}`,
                grantFreeSpin: false,
                punishmentCount: lshCount,
                banHours: activePunishment.ban_hours
            };
        }
    }

    // 2. 获取奖励规则并按优先级排序
    const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
    const activeRules = rules.filter(r => r.is_active).sort((a, b) => b.priority - a.priority);

    // 3. 按优先级检查规则
    for (const rule of activeRules) {
        const matched = checkRuleMatch(symbols, rule, isStrictConsecutive);

        if (matched) {
            return {
                winType: rule.rule_type,
                multiplier: rule.win_multiplier,
                ruleName: rule.rule_name,
                grantFreeSpin: rule.grant_free_spin > 0
            };
        }
    }

    // 4. 未匹配任何规则
    return {
        winType: 'none',
        multiplier: 0,
        ruleName: '未中奖',
        grantFreeSpin: false
    };
}

/**
 * 检查规则是否匹配
 * @param symbols 符号数组
 * @param rule 规则配置
 * @param isStrictConsecutive 是否严格连续（高级场true，初级场false）
 */
function checkRuleMatch(symbols: string[], rule: any, isStrictConsecutive: boolean): boolean {
    const pattern = rule.match_pattern;
    const matchCount = rule.match_count;
    
    // 🔥 安全解析 required_symbols
    let requiredSymbols = null;
    if (rule.required_symbols) {
        try {
            // 如果已经是数组，直接使用
            if (Array.isArray(rule.required_symbols)) {
                requiredSymbols = rule.required_symbols;
            } else if (typeof rule.required_symbols === 'string') {
                // 如果是字符串，尝试解析
                requiredSymbols = JSON.parse(rule.required_symbols);
            }
        } catch (error) {
            console.error('[规则匹配] JSON解析失败:', rule.required_symbols, error);
            requiredSymbols = null;
        }
    }

    switch (pattern) {
        case 'sequence':
            // 按顺序匹配（如 j→n→t→m）
            if (!requiredSymbols || requiredSymbols.length !== symbols.length) return false;
            return symbols.every((s, i) => s === requiredSymbols[i]);

        case 'combination':
            // 包含指定符号即可，顺序不限
            if (!requiredSymbols) return false;
            return requiredSymbols.every((req: string) => symbols.includes(req));

        case '4-consecutive':
        case '3-consecutive':
        case '2-consecutive':
        case 'consecutive':
            // N个连续相同符号（严格相邻）
            const n = parseInt(pattern.split('-')[0]) || matchCount;
            return hasConsecutive(symbols, n);

        case '3-any':
        case '2-any':
        case 'any':
            // N个相同符号（任意位置）
            // 🔥 高级场：即使是any模式，也要求严格连续
            if (isStrictConsecutive) {
                const n = parseInt(pattern.split('-')[0]) || matchCount;
                return hasConsecutive(symbols, n);
            } else {
                // 初级场：任意位置相同即可
                const count = parseInt(pattern.split('-')[0]) || matchCount;
                return hasNOfAKind(symbols, count);
            }

        case 'double_pair':
            // 两对2连（MMNN格式，排除4连）
            return hasTwoPairs(symbols);
        
        case 'symmetric':
            // 对称（前两个和后两个相同：AABB）
            return hasSymmetric(symbols);

        default:
            console.warn(`[规则匹配] 未知匹配模式: ${pattern}`);
            return false;
    }
}

/**
 * 检查是否有N个连续相同符号
 */
function hasConsecutive(symbols: string[], n: number): boolean {
    let maxConsecutive = 1;
    let currentConsecutive = 1;

    for (let i = 1; i < symbols.length; i++) {
        if (symbols[i] === symbols[i - 1]) {
            currentConsecutive++;
            maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
        } else {
            currentConsecutive = 1;
        }
    }

    return maxConsecutive >= n;
}

/**
 * 检查是否有N个相同符号（任意位置）
 */
function hasNOfAKind(symbols: string[], n: number): boolean {
    const counts: { [key: string]: number } = {};

    for (const symbol of symbols) {
        counts[symbol] = (counts[symbol] || 0) + 1;
    }

    return Object.values(counts).some(count => count >= n);
}

/**
 * 检查是否有两对2连（MMNN格式，排除4连）
 */
function hasTwoPairs(symbols: string[]): boolean {
    const counts: { [key: string]: number } = {};

    for (const symbol of symbols) {
        counts[symbol] = (counts[symbol] || 0) + 1;
    }

    // 必须恰好有2个不同符号，每个出现2次
    const pairs = Object.values(counts).filter(count => count === 2);
    return pairs.length === 2 && Object.keys(counts).length === 2;
}

/**
 * 检查是否对称（前两个和后两个相同：AABB）
 */
function hasSymmetric(symbols: string[]): boolean {
    if (symbols.length === 4) {
        return symbols[0] === symbols[1] && symbols[2] === symbols[3];
    }
    return false;
}

/**
 * 获取配置方案的所有规则和概率信息
 */
export function getSchemeRulesWithProbability(
    schemeId: number,
    weightConfigId: number
): {
    rules: any[];
    punishments: any[];
    probabilities: { [key: string]: number };
} {
    const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
    const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);

    // TODO: 计算每个规则的中奖概率（基于权重配置）
    // 这需要根据权重配置计算符号分布，然后模拟计算每个规则的中奖概率

    return {
        rules: rules.filter(r => r.is_active),
        punishments: punishments.filter(p => p.is_active),
        probabilities: {} // 暂时返回空对象，后续实现概率计算
    };
}

