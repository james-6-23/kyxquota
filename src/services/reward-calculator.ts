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
    // 🔥 1. 先检查律师函惩罚（最高优先级）
    const lshCount = symbols.filter(s => s === 'lsh').length;

    if (lshCount > 0) {
        const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);
        const activePunishment = punishments.find((p: any) => p.lsh_count === lshCount && p.is_active);

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

    // 🔥 2. 检查man符号并计算组合倍率
    const manCount = symbols.filter(s => s === 'man').length;
    let manMultiplier = 1.0;  // man的基础倍率
    
    if (manCount > 0) {
        // 检查man符号的连续性
        const manConsecutive = getMaxConsecutive(symbols, 'man');
        
        if (manCount === 4 || manConsecutive === 4) {
            // 4连man：25倍（不参与组合）
            return {
                winType: 'man_quad',
                multiplier: 25,
                ruleName: 'man×4',
                grantFreeSpin: false
            };
        } else if (manCount === 3 || manConsecutive === 3) {
            // 3连man：10倍（可与其他规则组合）
            manMultiplier = 10;
        } else if (manConsecutive === 2) {
            // 严格连续2连man：5倍（可与其他规则组合）
            manMultiplier = 5;
        } else if (manCount === 1) {
            // 单个man：2.5倍（可与其他规则组合）
            manMultiplier = 2.5;
        }
    }

    // 🔥 3. 检查对称规则ABBA（优先级高于严格2连）
    if (hasABBAPattern(symbols)) {
        // 检查是否有man的严格2连
        const hasManPair = hasManConsecutivePair(symbols);
        const finalMultiplier = hasManPair ? 10 * manMultiplier : 10;
        
        return {
            winType: 'symmetric',
            multiplier: finalMultiplier,
            ruleName: hasManPair ? '对称ABBA+man严格2连' : '对称ABBA',
            grantFreeSpin: false
        };
    }

    // 🔥 4. 获取奖励规则并按优先级排序
    const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
    const activeRules = rules.filter((r: any) => r.is_active).sort((a: any, b: any) => b.priority - a.priority);

    // 🔥 5. 检查规则匹配并应用man倍率加成
    for (const rule of activeRules) {
        const matched = checkRuleMatch(symbols, rule, isStrictConsecutive);

        if (matched) {
            let finalMultiplier = rule.win_multiplier;
            let ruleName = rule.rule_name;
            
            // 如果有man符号，并且匹配的是严格连续规则，应用man加成
            if (manMultiplier > 1.0) {
                // 检查是否是严格连续规则
                if (rule.match_pattern === 'consecutive' || 
                    rule.match_pattern === '2-consecutive' || 
                    rule.match_pattern === '3-consecutive' ||
                    rule.match_pattern === '4-consecutive') {
                    
                    // 严格连续规则可以与man组合
                    finalMultiplier = rule.win_multiplier * manMultiplier;
                    ruleName = `${rule.rule_name}+man×${manMultiplier}`;
                } else if (rule.match_pattern === 'double_pair') {
                    // 两对严格2连，检查是否有man的严格2连
                    if (hasManConsecutivePair(symbols)) {
                        finalMultiplier = rule.win_multiplier * 10;
                        ruleName = `${rule.rule_name}+man严格2连`;
                    }
                }
            }
            
            return {
                winType: rule.rule_type,
                multiplier: finalMultiplier,
                ruleName: ruleName,
                grantFreeSpin: rule.grant_free_spin > 0
            };
        }
    }

    // 🔥 6. 如果只有man没有其他规则匹配
    if (manMultiplier > 1.0) {
        return {
            winType: 'man_only',
            multiplier: manMultiplier,
            ruleName: `man×${manMultiplier}`,
            grantFreeSpin: false
        };
    }

    // 7. 未匹配任何规则
    return {
        winType: 'none',
        multiplier: 0,
        ruleName: '未中奖',
        grantFreeSpin: false
    };
}

/**
 * 检查是否有ABBA对称模式
 */
function hasABBAPattern(symbols: string[]): boolean {
    if (symbols.length !== 4) return false;
    // ABBA: symbols[0] === symbols[3] && symbols[1] === symbols[2]
    return symbols[0] === symbols[3] && symbols[1] === symbols[2] && symbols[0] !== symbols[1];
}

/**
 * 检查是否有man的严格连续2连
 */
function hasManConsecutivePair(symbols: string[]): boolean {
    for (let i = 0; i < symbols.length - 1; i++) {
        if (symbols[i] === 'man' && symbols[i + 1] === 'man') {
            return true;
        }
    }
    return false;
}

/**
 * 获取指定符号的最大连续数
 */
function getMaxConsecutive(symbols: string[], target: string): number {
    let maxConsecutive = 0;
    let currentConsecutive = 0;
    
    for (const symbol of symbols) {
        if (symbol === target) {
            currentConsecutive++;
            maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
        } else {
            currentConsecutive = 0;
        }
    }
    
    return maxConsecutive;
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
                // 过滤空字符串和无效字符串
                const trimmed = rule.required_symbols.trim();
                if (trimmed && trimmed !== '' && trimmed !== 'null' && trimmed !== 'undefined' && trimmed !== '[]') {
                    // 🔥 检查是否是完整的JSON（必须以 [ 开头并以 ] 结尾）
                    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
                        // 不是完整的JSON数组，跳过此规则
                        requiredSymbols = null;
                    } else {
                        // 如果是字符串，尝试解析
                        try {
                            const parsed = JSON.parse(trimmed);
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                requiredSymbols = parsed;
                            } else {
                                // 解析后不是有效数组，跳过此规则
                                requiredSymbols = null;
                            }
                        } catch (parseError) {
                            // JSON解析失败，跳过此规则（不输出错误日志，避免刷屏）
                            requiredSymbols = null;
                        }
                    }
                }
            }
        } catch (error) {
            // 处理时发生未预期的错误，跳过此规则
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
 * 检查是否对称（ABBA模式：前后对称）
 * 注意：AABB模式应该被识别为两对严格2连，不是对称
 */
function hasSymmetric(symbols: string[]): boolean {
    if (symbols.length === 4) {
        // ABBA: 第一个和第四个相同，第二个和第三个相同，但第一个和第二个不同
        return symbols[0] === symbols[3] && symbols[1] === symbols[2] && symbols[0] !== symbols[1];
    }
    return false;
}

/**
 * 获取配置方案的所有规则和概率信息
 */
export function getSchemeRulesWithProbability(
    schemeId: number,
    _weightConfigId: number
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
        rules: rules.filter((r: any) => r.is_active),
        punishments: punishments.filter((p: any) => p.is_active),
        probabilities: {} // 暂时返回空对象，后续实现概率计算
    };
}

