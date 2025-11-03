/**
 * 概率计算器
 * 提供快速估算和蒙特卡洛模拟两种计算方式
 */

import { rewardConfigQueries, weightConfigQueries } from '../database';
import logger from '../utils/logger';

// 符号列表
const SYMBOLS = ['m', 't', 'n', 'j', 'lq', 'bj', 'zft', 'bdk', 'lsh', 'man'];

// 🔥 概率计算结果缓存（内存缓存）
interface CacheKey {
    weightConfigId: number;
    rewardSchemeId: number;
    method: 'fast' | 'monte-carlo';
}

interface CacheEntry {
    result: ProbabilityResult;
    timestamp: number;
}

const probabilityCache = new Map<string, CacheEntry>();
// 🔥 改为永久缓存：不再设置过期时间，只在配置变更时主动更新
// const CACHE_TTL = 30 * 60 * 1000; // 已废弃，改为永久缓存

/**
 * 生成缓存键
 */
function getCacheKey(weightConfigId: number, rewardSchemeId: number, method: 'fast' | 'monte-carlo'): string {
    return `${weightConfigId}-${rewardSchemeId}-${method}`;
}

/**
 * 从缓存获取结果（永久缓存，不检查过期时间）
 */
export function getFromCache(weightConfigId: number, rewardSchemeId: number, method: 'fast' | 'monte-carlo'): ProbabilityResult | null {
    const key = getCacheKey(weightConfigId, rewardSchemeId, method);
    const entry = probabilityCache.get(key);

    if (!entry) {
        return null;
    }

    // 🔥 永久缓存：不再检查过期时间
    logger.debug('缓存', `命中: ${key}`);
    return entry.result;
}

/**
 * 保存结果到缓存
 */
function saveToCache(weightConfigId: number, rewardSchemeId: number, method: 'fast' | 'monte-carlo', result: ProbabilityResult): void {
    const key = getCacheKey(weightConfigId, rewardSchemeId, method);
    probabilityCache.set(key, {
        result,
        timestamp: Date.now()
    });
}

/**
 * 清理过期缓存（已废弃：改为永久缓存后不再需要清理过期项）
 * 保留此函数以兼容旧代码，但不再执行任何操作
 */
export function cleanExpiredCache(): void {
    // 🔥 永久缓存：不再清理过期项
    // 缓存会在配置变更时主动更新，无需定期清理
    const cacheSize = probabilityCache.size;
    const memoryUsage = (JSON.stringify([...probabilityCache.entries()]).length / 1024 / 1024).toFixed(2);
    logger.info('缓存状态', `当前缓存 ${cacheSize} 个方案，内存占用约 ${memoryUsage}MB`);
}

/**
 * 🔥 清除所有概率缓存（用于修复计算逻辑后重新计算）
 */
export function clearAllCache(): void {
    const oldSize = probabilityCache.size;
    probabilityCache.clear();
    logger.info('缓存清理', `已清除所有缓存（共${oldSize}个方案）`);
}

/**
 * 权重配置接口
 */
interface WeightConfig {
    weight_m: number;
    weight_t: number;
    weight_n: number;
    weight_j: number;
    weight_lq: number;
    weight_bj: number;
    weight_zft: number;
    weight_bdk: number;
    weight_lsh: number;
    weight_man?: number;  // 可选，兼容旧配置
}

/**
 * 规则概率结果
 */
export interface RuleProbability {
    ruleName: string;
    multiplier: number;
    probability: number;  // 0-100
    expectedValue: number;  // 期望值
    count?: number;  // 出现次数（蒙特卡洛）
}

/**
 * 概率计算结果
 */
export interface ProbabilityResult {
    rules: RuleProbability[];
    punishments: RuleProbability[];
    noWin: RuleProbability;
    rtp: number;  // 玩家回报率 (%)
    houseEdge: number;  // 庄家优势 (%)
    totalExpectedValue: number;  // 总期望值
    method: 'fast' | 'monte-carlo';
    simulationCount?: number;
    calculationTime: number;  // 计算耗时(ms)
}

/**
 * 根据权重生成一个符号
 */
function generateSymbolByWeight(weightConfig: WeightConfig): string {
    const weights = [
        weightConfig.weight_m,
        weightConfig.weight_t,
        weightConfig.weight_n,
        weightConfig.weight_j,
        weightConfig.weight_lq,
        weightConfig.weight_bj,
        weightConfig.weight_zft,
        weightConfig.weight_bdk,
        weightConfig.weight_lsh,
        weightConfig.weight_man || 25  // 兼容旧配置
    ];

    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const random = Math.random() * totalWeight;

    let cumulative = 0;
    for (let i = 0; i < SYMBOLS.length; i++) {
        cumulative += weights[i];
        if (random < cumulative) {
            return SYMBOLS[i];
        }
    }

    return SYMBOLS[0];  // fallback
}

/**
 * 生成4个符号
 */
function generateSymbols(weightConfig: WeightConfig): string[] {
    return [
        generateSymbolByWeight(weightConfig),
        generateSymbolByWeight(weightConfig),
        generateSymbolByWeight(weightConfig),
        generateSymbolByWeight(weightConfig)
    ];
}

/**
 * 检查规则是否匹配
 */
function checkRuleMatch(symbols: string[], rule: any, debug: boolean = false): boolean {
    const { match_pattern, match_count, required_symbols, rule_name } = rule;

    // 🔥 安全解析 required_symbols - 支持多种格式
    let requiredArr: string[] = [];
    if (required_symbols) {
        try {
            // 如果已经是数组，直接使用
            if (Array.isArray(required_symbols)) {
                requiredArr = required_symbols;
            } else if (typeof required_symbols === 'string') {
                const trimmed = required_symbols.trim();

                // 尝试JSON解析（支持 ["a","b","c"] 格式）
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                    requiredArr = JSON.parse(trimmed);
                }
                // 逗号分隔字符串（支持 "a,b,c" 格式）
                else if (trimmed.includes(',')) {
                    requiredArr = trimmed.split(',').map(s => s.trim()).filter(s => s);
                }
                // 单个符号
                else if (trimmed) {
                    requiredArr = [trimmed];
                }
            }
        } catch (e) {
            console.error(`[规则匹配] "${rule_name}" 解析 required_symbols 失败:`, required_symbols, e);
            // 降级处理：尝试当作逗号分隔字符串
            if (typeof required_symbols === 'string') {
                const fallback = required_symbols.split(',').map(s => s.trim()).filter(s => s);
                if (fallback.length > 0) {
                    console.log(`[规则匹配] "${rule_name}" 使用降级解析:`, fallback);
                    requiredArr = fallback;
                } else {
                    return false;
                }
            } else {
                return false;
            }
        }
    }

    // 🔥 完全禁用规则匹配的详细日志（优化性能和日志简洁性）
    // debug 参数已被忽略，仅在发生错误时输出日志

    let matched = false;

    // 🔥 处理匹配模式：兼容 "any" 和 "2-any" 两种格式
    let normalizedPattern = match_pattern;

    // 如果是 "2-any", "3-consecutive" 等格式，提取出基础模式
    if (match_pattern.includes('-')) {
        const parts = match_pattern.split('-');
        normalizedPattern = parts[1]; // 取 "any" 或 "consecutive"
    }

    switch (normalizedPattern) {
        case 'sequence':  // 按顺序
            matched = JSON.stringify(symbols) === JSON.stringify(requiredArr);
            break;

        case 'combination':  // 任意顺序包含
            matched = requiredArr.every(sym => symbols.includes(sym));
            break;

        case 'consecutive':  // 相邻连续
            // 🔥 如果指定了required_symbols，必须验证符号类型
            if (requiredArr && requiredArr.length > 0) {
                // 检查是否有指定符号的N连
                const targetSymbol = requiredArr[0];
                let currentConsecutive = 0;
                for (const symbol of symbols) {
                    if (symbol === targetSymbol) {
                        currentConsecutive++;
                        if (currentConsecutive >= (match_count || 2)) {
                            matched = true;
                            break;
                        }
                    } else {
                        currentConsecutive = 0;
                    }
                }
            } else {
                // 没有指定required_symbols，任意符号N连即可
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
            matched = maxConsecutive >= (match_count || 2);
            }
            break;

        case 'any':  // 任意位置相同
            const counts: Record<string, number> = {};
            symbols.forEach(s => counts[s] = (counts[s] || 0) + 1);
            const maxCount = Math.max(...Object.values(counts));
            matched = maxCount >= (match_count || 2);
            break;

        case 'double_pair':  // 两对2连（MMNN格式，排除4连）
            const pairCounts: Record<string, number> = {};
            symbols.forEach(s => pairCounts[s] = (pairCounts[s] || 0) + 1);
            // 必须恰好有2个不同符号，每个出现2次
            const pairs = Object.values(pairCounts).filter(count => count === 2);
            if (pairs.length === 2 && Object.keys(pairCounts).length === 2) {
                // 🔥 检查是否严格连续：前两个相同且后两个相同（MMNN 或 NNMM）
                matched = symbols[0] === symbols[1] && symbols[2] === symbols[3] && symbols[0] !== symbols[2];
            } else {
                matched = false;
            }
            break;

        case 'symmetric':  // 对称（ABBA格式：前后对称）
            if (symbols.length === 4) {
                // 🔥 ABBA: 第一个和第四个相同，第二个和第三个相同，但第一个和第二个不同
                matched = symbols[0] === symbols[3] && symbols[1] === symbols[2] && symbols[0] !== symbols[1];
            } else {
                matched = false;
            }
            break;

        default:
            matched = false;
    }

    // 🔥 禁用匹配结果日志（已在快速估算中统一输出示例）
    return matched;
}

/**
 * 匹配规则（按优先级）- 与reward-calculator保持一致
 */
function matchRuleByPriority(symbols: string[], schemeId: number, debug: boolean = false): {
    ruleName: string;
    multiplier: number;
    punishmentCount?: number;
} {
    // 🔥 1. 先检查man符号并计算组合倍率（最高优先级）
    // 如果有man，则不会触发律师函惩罚
    const manCount = symbols.filter(s => s === 'man').length;
    let manMultiplier = 1.0;

    if (manCount > 0) {
        const manConsecutive = getMaxConsecutiveSymbol(symbols, 'man');

        if (manCount === 4 || manConsecutive === 4) {
            return {
                ruleName: 'man×4',
                multiplier: 25
            };
        } else if (manCount === 3 || manConsecutive === 3) {
            manMultiplier = 10;
        } else if (manCount === 2 || manConsecutive === 2) {
            manMultiplier = 5;
        } else if (manCount === 1) {
            manMultiplier = 2.5;
        }
    }

    // 🔥 2. 检查律师函惩罚（仅在没有man符号时触发）
    if (manCount === 0) {
        const lshCount = symbols.filter(s => s === 'lsh').length;
        if (lshCount > 0) {
            const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);
            const punishment = punishments.find(p => p.lsh_count === lshCount && p.is_active);
            if (punishment) {
                return {
                    ruleName: `律师函×${lshCount}`,
                    multiplier: -punishment.deduct_multiplier,
                    punishmentCount: lshCount
                };
            }
        }
    }

    // 🔥 3. 检查对称规则ABBA
    if (hasABBAPatternProb(symbols)) {
        const hasManPair = hasManConsecutivePairProb(symbols);
        const finalMultiplier = hasManPair ? 10 * manMultiplier : 10;
        return {
            ruleName: hasManPair ? '对称ABBA+man严格2连' : '对称ABBA',
            multiplier: finalMultiplier
        };
    }

    // 🔥 4. 按优先级检查奖励规则
    const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
    const activeRules = rules.filter(r => r.is_active).sort((a, b) => b.priority - a.priority);

    for (const rule of activeRules) {
        if (checkRuleMatch(symbols, rule, debug)) {
            let finalMultiplier = rule.win_multiplier;
            let ruleName = rule.rule_name;
            
            // 应用man加成
            if (manMultiplier > 1.0) {
                // 🔥 检查是否是专门的Man规则（避免双重计算）
                let isManSpecificRule = false;
                try {
                    if (rule.required_symbols) {
                        const requiredArr = Array.isArray(rule.required_symbols) 
                            ? rule.required_symbols 
                            : JSON.parse(rule.required_symbols);
                        // 如果required_symbols只包含"man"，说明是专门的man规则
                        isManSpecificRule = requiredArr.length === 1 && requiredArr[0] === 'man';
                    }
                } catch (e) {
                    // 解析失败，按非man专用规则处理
                }
                
                // 只对非man专用规则应用man加成
                if (!isManSpecificRule) {
                if (rule.match_pattern === 'consecutive' || 
                    rule.match_pattern === '2-consecutive' || 
                    rule.match_pattern === '3-consecutive' ||
                    rule.match_pattern === '4-consecutive') {
                    finalMultiplier = rule.win_multiplier * manMultiplier;
                    ruleName = `${rule.rule_name}+man×${manMultiplier}`;
                } else if (rule.match_pattern === 'double_pair') {
                    if (hasManConsecutivePairProb(symbols)) {
                        finalMultiplier = rule.win_multiplier * 10;
                        ruleName = `${rule.rule_name}+man严格2连`;
                        }
                    }
                }
            }
            
            return {
                ruleName: ruleName,
                multiplier: finalMultiplier
            };
        }
    }

    // 🔥 5. 如果只有man没有其他规则匹配
    if (manMultiplier > 1.0) {
        return {
            ruleName: `man×${manMultiplier}`,
            multiplier: manMultiplier
        };
    }

    // 6. 未中奖
    return {
        ruleName: '未中奖',
        multiplier: 0
    };
}

/**
 * 检查是否有ABBA对称模式
 */
function hasABBAPatternProb(symbols: string[]): boolean {
    if (symbols.length !== 4) return false;
    return symbols[0] === symbols[3] && symbols[1] === symbols[2] && symbols[0] !== symbols[1];
}

/**
 * 检查是否有man的严格连续2连
 */
function hasManConsecutivePairProb(symbols: string[]): boolean {
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
function getMaxConsecutiveSymbol(symbols: string[], target: string): number {
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
 * 蒙特卡洛模拟
 * @param onProgress 进度回调 (current, total, percentage)
 */
export function calculateProbabilityMonteCarlo(
    weightConfigId: number,
    rewardSchemeId: number,
    simulationCount: number = 1000000,
    onProgress?: (current: number, total: number, percentage: number) => void
): ProbabilityResult {
    // 🔥 检查缓存
    const cached = getFromCache(weightConfigId, rewardSchemeId, 'monte-carlo');
    if (cached) {
        console.log('[蒙特卡洛] 使用缓存结果');
        return cached;
    }

    const startTime = Date.now();

    // 获取配置
    const weightConfig = weightConfigQueries.getById.get(weightConfigId);
    if (!weightConfig) {
        throw new Error('权重配置不存在');
    }

    // 🔥 调试：检查权重配置
    console.log(`[蒙特卡洛] 权重配置ID:${weightConfigId}, weight_man字段:`, weightConfig.weight_man);

    // 🔥 调试：检查规则数量
    const allRules = rewardConfigQueries.getRulesByScheme.all(rewardSchemeId);
    const activeRules = allRules.filter(r => r.is_active);
    console.log(`[蒙特卡洛] 开始计算 - 权重ID: ${weightConfigId}, 奖励ID: ${rewardSchemeId}`);
    console.log(`[蒙特卡洛] 总规则: ${allRules.length}, 激活规则: ${activeRules.length}`);
    console.log(`[蒙特卡洛] 规则详情:`, allRules.map(r => `${r.rule_name}(active:${r.is_active})`));

    // 🔥 初始化统计（确保所有激活规则都会出现在结果中）
    const stats: Record<string, { count: number; multiplier: number }> = {};

    // 🔥 预先初始化所有激活规则
    activeRules.forEach(rule => {
        stats[rule.rule_name] = { count: 0, multiplier: rule.win_multiplier };
    });

    // 🔥 初始化所有可能的律师函惩罚
    const allPunishments = rewardConfigQueries.getPunishmentsByScheme.all(rewardSchemeId);
    allPunishments.filter(p => p.is_active).forEach(p => {
        stats[`律师函×${p.lsh_count}`] = { count: 0, multiplier: -p.deduct_multiplier };
    });

    // 🔥 初始化未中奖
    stats['未中奖'] = { count: 0, multiplier: 0 };

    // 进度报告间隔（每10000次报告一次）
    const reportInterval = 10000;

    // 模拟N次游戏
    for (let i = 0; i < simulationCount; i++) {
        const symbols = generateSymbols(weightConfig);
        const result = matchRuleByPriority(symbols, rewardSchemeId);

        // 🔥 如果规则不存在（理论上不应该发生），仍然记录它
        if (!stats[result.ruleName]) {
            stats[result.ruleName] = { count: 0, multiplier: result.multiplier };
        }
        stats[result.ruleName].count++;

        // 🔄 报告进度
        if (onProgress && i % reportInterval === 0) {
            const percentage = (i / simulationCount) * 100;
            onProgress(i, simulationCount, percentage);
        }
    }

    // 最终进度
    if (onProgress) {
        onProgress(simulationCount, simulationCount, 100);
    }

    // 计算概率和期望值
    const rules: RuleProbability[] = [];
    const punishments: RuleProbability[] = [];
    let noWin: RuleProbability = {
        ruleName: '未中奖',
        multiplier: 0,
        probability: 0,
        expectedValue: 0
    };

    let totalExpectedValue = 0;

    for (const [ruleName, stat] of Object.entries(stats)) {
        const probability = (stat.count / simulationCount) * 100;
        const expectedValue = (probability / 100) * stat.multiplier;
        totalExpectedValue += expectedValue;

        const item: RuleProbability = {
            ruleName,
            multiplier: stat.multiplier,
            probability,
            expectedValue,
            count: stat.count
        };

        if (ruleName === '未中奖') {
            noWin = item;
        } else if (ruleName.includes('律师函')) {
            punishments.push(item);
        } else {
            rules.push(item);
        }
    }

    // 按概率降序排序
    rules.sort((a, b) => b.probability - a.probability);
    punishments.sort((a, b) => a.ruleName.localeCompare(b.ruleName));  // 按律师函数量排序

    const calculationTime = Date.now() - startTime;

    const result: ProbabilityResult = {
        rules,
        punishments,
        noWin,
        rtp: totalExpectedValue * 100,  // RTP百分比
        houseEdge: (1 - totalExpectedValue) * 100,
        totalExpectedValue,
        method: 'monte-carlo',
        simulationCount,
        calculationTime
    };

    // 🔥 保存到缓存
    saveToCache(weightConfigId, rewardSchemeId, 'monte-carlo', result);

    return result;
}

/**
 * 快速估算（基于数学公式）
 */
export function calculateProbabilityFast(
    weightConfigId: number,
    rewardSchemeId: number
): ProbabilityResult {
    // 🔥 检查缓存
    const cached = getFromCache(weightConfigId, rewardSchemeId, 'fast');
    if (cached) {
        return cached;
    }

    const startTime = Date.now();

    // 获取配置
    const weightConfig = weightConfigQueries.getById.get(weightConfigId);
    if (!weightConfig) {
        throw new Error('权重配置不存在');
    }

    // 🔥 调试：输出权重配置
    console.log(`[快速估算] 权重配置ID:${weightConfigId}, weight_man字段:`, weightConfig.weight_man);

    const weights = [
        weightConfig.weight_m,
        weightConfig.weight_t,
        weightConfig.weight_n,
        weightConfig.weight_j,
        weightConfig.weight_lq,
        weightConfig.weight_bj,
        weightConfig.weight_zft,
        weightConfig.weight_bdk,
        weightConfig.weight_lsh,
        weightConfig.weight_man || 25  // 🔥 添加man符号权重
    ];
    
    console.log(`[快速估算] 权重数组:`, weights);
    console.log(`[快速估算] 总权重:`, weights.reduce((a, b) => a + b, 0));

    const totalWeight = weights.reduce((a, b) => a + b, 0);

    // 计算单个符号概率
    const symbolProbs = SYMBOLS.map((_, i) => weights[i] / totalWeight);

    const rules: RuleProbability[] = [];
    const punishments: RuleProbability[] = [];

    // 🔥 使用模拟来计算所有规则概率（包括律师函），确保总和为100%
    const quickSimCount = 100000;
    const quickStats: Record<string, { count: number; multiplier: number }> = {};

    // 🔥 获取所有激活的规则
    const allRules = rewardConfigQueries.getRulesByScheme.all(rewardSchemeId);
    const activeRules = allRules.filter(r => r.is_active);

    // 🔥 初始化所有激活规则的统计
    activeRules.forEach(rule => {
        quickStats[rule.rule_name] = { count: 0, multiplier: rule.win_multiplier };
    });

    // 🔥 初始化所有可能的律师函惩罚
    const allPunishments = rewardConfigQueries.getPunishmentsByScheme.all(rewardSchemeId);
    allPunishments.filter(p => p.is_active).forEach(p => {
        quickStats[`律师函×${p.lsh_count}`] = { count: 0, multiplier: -p.deduct_multiplier };
    });

    // 🔥 初始化未中奖
    quickStats['未中奖'] = { count: 0, multiplier: 0 };

    // 🔥 简化日志：仅输出前3次模拟的最终结果（压缩到3行）
    let debugCount = 0;
    const maxDebug = 3;
    const debugResults: string[] = [];

    for (let i = 0; i < quickSimCount; i++) {
        const symbols = generateSymbols(weightConfig);
        const enableDebug = false; // 禁用规则匹配的详细日志
        const result = matchRuleByPriority(symbols, rewardSchemeId, enableDebug);

        if (debugCount < maxDebug) {
            debugCount++;
            debugResults.push(`#${debugCount}[${symbols.join(',')}]→${result.ruleName}(${result.multiplier}x)`);
        }

        // 🔥 统计所有规则（不再排除律师函）
        if (!quickStats[result.ruleName]) {
            // 如果规则不存在（理论上不应该发生），动态添加
            quickStats[result.ruleName] = { count: 0, multiplier: result.multiplier };
        }
        quickStats[result.ruleName].count++;
    }

    // 🔥 一次性输出所有示例（压缩到1行）
    if (debugResults.length > 0) {
        logger.info('快速估算示例', debugResults.join(' | '));
    }

    let totalExpectedValue = 0;

    // 🔥 计算所有规则的概率（包括奖励、惩罚、未中奖）
    for (const [ruleName, stat] of Object.entries(quickStats)) {
        const probability = (stat.count / quickSimCount) * 100;
        const expectedValue = (probability / 100) * stat.multiplier;
        totalExpectedValue += expectedValue;

        const item: RuleProbability = {
            ruleName,
            multiplier: stat.multiplier,
            probability,
            expectedValue
        };

        if (ruleName === '未中奖') {
            // 未中奖单独处理（后面会用到）
            continue;
        } else if (ruleName.includes('律师函')) {
            punishments.push(item);
        } else {
            rules.push(item);
        }
    }

    // 未中奖概率
    const noWinStat = quickStats['未中奖'];
    const noWinProb = noWinStat ? (noWinStat.count / quickSimCount * 100) : 0;

    // 按概率降序排序
    rules.sort((a, b) => b.probability - a.probability);
    punishments.sort((a, b) => a.ruleName.localeCompare(b.ruleName));  // 按律师函数量排序

    const calculationTime = Date.now() - startTime;

    const result: ProbabilityResult = {
        rules,
        punishments,
        noWin: {
            ruleName: '未中奖',
            multiplier: 0,
            probability: noWinProb,
            expectedValue: 0
        },
        rtp: totalExpectedValue * 100,
        houseEdge: (1 - totalExpectedValue) * 100,
        totalExpectedValue,
        method: 'fast',
        calculationTime
    };

    // 🔥 保存到缓存
    saveToCache(weightConfigId, rewardSchemeId, 'fast', result);

    return result;
}

/**
 * 计算二项式系数 C(n, k)
 */
function binomialCoefficient(n: number, k: number): number {
    if (k === 0 || k === n) return 1;
    if (k === 1 || k === n - 1) return n;

    let result = 1;
    for (let i = 0; i < k; i++) {
        result *= (n - i);
        result /= (i + 1);
    }
    return result;
}

/**
 * 🔥 为指定方案重新计算概率（管理员保存配置时调用）
 * 遍历所有使用该方案的场次，预先计算并缓存概率
 * 使用蒙特卡洛方法进行精确计算
 */
export async function recalculateProbabilityForScheme(schemeId: number): Promise<void> {
    logger.info('概率预计算', `🔄 方案${schemeId} 开始计算（蒙特卡洛精确计算）...`);

    try {
        const { weightConfigQueries, slotQueries, advancedSlotQueries, supremeSlotQueries } = await import('../database');

        // 获取三个场次的配置，看哪些使用了这个方案
        const normalConfig = slotQueries.getConfig.get();
        const advancedConfig = advancedSlotQueries.getAdvancedConfig.get();
        const supremeConfig = supremeSlotQueries.getConfig.get();

        const weightConfigsToCalculate = new Set<number>();

        // 收集使用该方案的权重配置ID
        if (normalConfig && normalConfig.reward_scheme_id === schemeId) {
            weightConfigsToCalculate.add(normalConfig.weight_config_id || 1);
        }
        if (advancedConfig && advancedConfig.reward_scheme_id === schemeId) {
            weightConfigsToCalculate.add(advancedConfig.weight_config_id || 1);
        }
        if (supremeConfig && supremeConfig.reward_scheme_id === schemeId) {
            weightConfigsToCalculate.add(supremeConfig.weight_config_id || 1);
        }

        // 如果没有场次使用该方案，计算默认权重
        if (weightConfigsToCalculate.size === 0) {
            weightConfigsToCalculate.add(1);
        }

        // 计算每个权重配置的概率（使用蒙特卡洛方法）
        let successCount = 0;
        for (const weightConfigId of weightConfigsToCalculate) {
            try {
                // 🔥 改用蒙特卡洛方法（100万次模拟）
                const result = calculateProbabilityMonteCarlo(weightConfigId, schemeId, 1000000);
                logger.info('概率预计算', `✅ 权重${weightConfigId} RTP:${result.rtp.toFixed(2)}% (耗时:${result.calculationTime}ms)`);
                successCount++;
            } catch (error: any) {
                logger.error('概率预计算', `❌ 权重${weightConfigId} 失败: ${error.message}`);
            }
        }

        logger.info('概率预计算', `🎉 完成${successCount}/${weightConfigsToCalculate.size}`);
    } catch (error: any) {
        logger.error('概率预计算', `失败: ${error.message}`);
        throw error;
    }
}

/**
 * 🔥 启动时预热所有场次的概率缓存
 * 在应用启动时调用，避免重启后缓存丢失
 * 使用蒙特卡洛方法进行精确计算
 */
export async function warmupAllProbabilityCache(): Promise<void> {
    logger.info('缓存预热', '🔥 开始预热所有场次的概率缓存（蒙特卡洛精确计算）...');

    // 🔥 先清除旧缓存（确保使用最新的计算逻辑）
    clearAllCache();

    try {
        const { slotQueries, advancedSlotQueries, supremeSlotQueries, rewardConfigQueries, weightConfigQueries, dropConfigQueries } = await import('../database');

        // 获取所有场次的配置
        const normalConfig = slotQueries.getConfig.get();
        const advancedConfig = advancedSlotQueries.getAdvancedConfig.get();
        const supremeConfig = supremeSlotQueries.getConfig.get();

        // 定义场次配置
        const venues = [
            { name: '初级场', config: normalConfig, type: 'normal' as const },
            { name: '高级场', config: advancedConfig, type: 'advanced' as const },
            { name: '至尊场', config: supremeConfig, type: 'supreme' as const }
        ];

        let successCount = 0;
        let totalCount = 0;

        for (const venue of venues) {
            const { name, config, type } = venue;

            if (!config) {
                logger.warn('缓存预热', `⚠️ ${name}配置不存在，跳过`);
                continue;
            }

            totalCount++;

            const weightConfigId = config.weight_config_id || 1;
            const schemeId = config.reward_scheme_id || 1;

            try {
                // 检查方案是否存在
                const scheme = rewardConfigQueries.getSchemeById.get(schemeId);
                if (!scheme) {
                    logger.warn('缓存预热', `⚠️ ${name}方案${schemeId}不存在，跳过`);
                    continue;
                }

                // 获取权重配置
                const weightConfig = weightConfigQueries.getById.get(weightConfigId);
                if (!weightConfig) {
                    logger.warn('缓存预热', `⚠️ ${name}权重${weightConfigId}不存在，跳过`);
                    continue;
                }

                logger.info('缓存预热', `\n${'='.repeat(60)}`);
                logger.info('缓存预热', `📍 ${name} - 开始计算概率`);
                logger.info('缓存预热', `${'='.repeat(60)}`);

                // 🔥 使用蒙特卡洛方法计算（100万次模拟）
                const result = calculateProbabilityMonteCarlo(
                    weightConfigId,
                    schemeId,
                    1000000,
                    (current, total, percentage) => {
                        // 每10%报告一次进度
                        if (percentage % 10 === 0 && percentage > 0) {
                            logger.info('缓存预热', `${name} 计算进度: ${percentage.toFixed(0)}%`);
                        }
                    }
                );

                // 显示权重配置
                logger.info('缓存预热', `\n📊 权重配置 (ID:${weightConfigId}):`);
                const totalWeight = weightConfig.weight_m + weightConfig.weight_t + weightConfig.weight_n + weightConfig.weight_j +
                    weightConfig.weight_lq + weightConfig.weight_bj + weightConfig.weight_zft + weightConfig.weight_bdk +
                    weightConfig.weight_lsh + (weightConfig.weight_man || 0);

                logger.info('缓存预热', `  M:${weightConfig.weight_m} T:${weightConfig.weight_t} N:${weightConfig.weight_n} J:${weightConfig.weight_j}`);
                logger.info('缓存预热', `  LQ:${weightConfig.weight_lq} BJ:${weightConfig.weight_bj} ZFT:${weightConfig.weight_zft} BDK:${weightConfig.weight_bdk}`);
                logger.info('缓存预热', `  LSH:${weightConfig.weight_lsh} MAN:${weightConfig.weight_man || 0} | 总权重:${totalWeight}`);

                // 显示中奖规则概率（前10个）
                logger.info('缓存预热', `\n🎰 中奖规则概率 (方案ID:${schemeId}):`);
                result.rules.slice(0, 10).forEach((rule, idx) => {
                    logger.info('缓存预热', `  ${idx + 1}. ${rule.ruleName} - ${rule.probability.toFixed(4)}% (${rule.multiplier}x) [期望:${rule.expectedValue.toFixed(4)}]`);
                });
                if (result.rules.length > 10) {
                    logger.info('缓存预热', `  ... 还有 ${result.rules.length - 10} 个规则`);
                }

                // 显示惩罚规则
                if (result.punishments.length > 0) {
                    logger.info('缓存预热', `\n⚖️ 惩罚规则:`);
                    result.punishments.forEach((punishment) => {
                        logger.info('缓存预热', `  ${punishment.ruleName} - ${punishment.probability.toFixed(4)}% (${punishment.multiplier}x)`);
                    });
                }

                // 显示未中奖概率
                logger.info('缓存预热', `\n❌ 未中奖概率: ${result.noWin.probability.toFixed(4)}%`);

                // 显示RTP和庄家优势
                logger.info('缓存预热', `\n💰 玩家回报率(RTP): ${result.rtp.toFixed(2)}%`);
                logger.info('缓存预热', `🏦 庄家优势: ${result.houseEdge.toFixed(2)}%`);
                logger.info('缓存预热', `⏱️  计算耗时: ${result.calculationTime}ms`);
                logger.info('缓存预热', `📦 模拟次数: ${result.simulationCount?.toLocaleString()}`);

                // 显示掉落配置
                try {
                    const dropConfigs = dropConfigQueries.getByVenue.all(type);
                    if (dropConfigs.length > 0) {
                        logger.info('缓存预热', `\n🎁 掉落配置:`);
                        dropConfigs.forEach((drop: any) => {
                            const dropRate = (drop.drop_rate * 100).toFixed(2);
                            const triggerInfo = drop.trigger_rule_name || '任意规则';
                            logger.info('缓存预热', `  ${drop.item_name} x${drop.quantity} - ${dropRate}% (触发:${triggerInfo})`);
                        });
                    }
                } catch (error: any) {
                    // 掉落配置获取失败不影响预热
                    logger.debug('缓存预热', `掉落配置获取失败: ${error.message}`);
                }

                logger.info('缓存预热', `\n✅ ${name}概率缓存预热成功！`);
                logger.info('缓存预热', `${'='.repeat(60)}\n`);

                successCount++;
            } catch (error: any) {
                logger.error('缓存预热', `❌ ${name}预热失败: ${error.message}`);
                if (error.stack) {
                    logger.debug('缓存预热', `错误堆栈: ${error.stack}`);
                }
            }
        }

        logger.info('缓存预热', `\n🎉 概率缓存预热完成: ${successCount}/${totalCount} 个场次成功`);
    } catch (error: any) {
        logger.error('缓存预热', `预热失败: ${error.message}`);
        if (error.stack) {
            logger.error('缓存预热', `错误堆栈: ${error.stack}`);
        }
        // 不抛出异常，避免影响应用启动
    }
}

