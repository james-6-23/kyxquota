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
            matched = pairs.length === 2 && Object.keys(pairCounts).length === 2;
            break;

        case 'symmetric':  // 对称（前两个和后两个相同：AABB）
            if (symbols.length === 4) {
                matched = symbols[0] === symbols[1] && symbols[2] === symbols[3];
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
    // 🔥 1. 先检查律师函惩罚（最高优先级）
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

    // 🔥 2. 检查man符号并计算组合倍率
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
        } else if (manConsecutive === 2) {
            manMultiplier = 5;
        } else if (manCount === 1) {
            manMultiplier = 2.5;
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

    const weights = [
        weightConfig.weight_m,
        weightConfig.weight_t,
        weightConfig.weight_n,
        weightConfig.weight_j,
        weightConfig.weight_lq,
        weightConfig.weight_bj,
        weightConfig.weight_zft,
        weightConfig.weight_bdk,
        weightConfig.weight_lsh
    ];

    const totalWeight = weights.reduce((a, b) => a + b, 0);

    // 计算单个符号概率
    const symbolProbs = SYMBOLS.map((_, i) => weights[i] / totalWeight);

    const rules: RuleProbability[] = [];
    const punishments: RuleProbability[] = [];

    // 1. 计算律师函概率
    const lshProb = symbolProbs[8];  // lsh是第9个
    for (let lshCount = 1; lshCount <= 4; lshCount++) {
        // 计算恰好lshCount个律师函的概率（二项分布）
        const combinations = binomialCoefficient(4, lshCount);
        const probability = combinations * Math.pow(lshProb, lshCount) * Math.pow(1 - lshProb, 4 - lshCount) * 100;

        // 获取惩罚倍率
        const allPunishments = rewardConfigQueries.getPunishmentsByScheme.all(rewardSchemeId);
        const punishment = allPunishments.find(p => p.lsh_count === lshCount && p.is_active);
        const multiplier = punishment ? -punishment.deduct_multiplier : -lshCount;

        punishments.push({
            ruleName: `律师函×${lshCount}`,
            multiplier,
            probability,
            expectedValue: (probability / 100) * multiplier
        });
    }

    // 2. 估算其他规则（简化计算）
    // 🔥 使用更多次模拟以提高准确性（从10000提升到100000）
    const quickSimCount = 100000;
    const quickStats: Record<string, number> = {};

    // 🔥 获取所有激活的规则，确保它们都会出现在结果中
    const allRules = rewardConfigQueries.getRulesByScheme.all(rewardSchemeId);
    const activeRules = allRules.filter(r => r.is_active);

    // 🔥 初始化所有激活规则的统计为0
    activeRules.forEach(rule => {
        quickStats[rule.rule_name] = 0;
    });
    quickStats['未中奖'] = 0;

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

        // 排除律师函（已单独计算）
        if (!result.ruleName.includes('律师函')) {
            quickStats[result.ruleName] = (quickStats[result.ruleName] || 0) + 1;
        }
    }

    // 🔥 一次性输出所有示例（压缩到1行）
    if (debugResults.length > 0) {
        logger.info('快速估算示例', debugResults.join(' | '));
    }

    let totalExpectedValue = 0;

    // 🔥 计算奖励规则概率（遍历所有激活规则）
    for (const rule of activeRules) {
        const count = quickStats[rule.rule_name] || 0;
        const probability = (count / quickSimCount) * 100;
        const multiplier = rule.win_multiplier;
        const expectedValue = (probability / 100) * multiplier;

        totalExpectedValue += expectedValue;

        rules.push({
            ruleName: rule.rule_name,
            multiplier,
            probability,
            expectedValue
        });
    }

    // 添加律师函期望值
    punishments.forEach(p => {
        totalExpectedValue += p.expectedValue;
    });

    // 未中奖概率
    const noWinProb = quickStats['未中奖'] ? (quickStats['未中奖'] / quickSimCount * 100) : 0;

    rules.sort((a, b) => b.probability - a.probability);

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
 */
export async function recalculateProbabilityForScheme(schemeId: number): Promise<void> {
    logger.info('概率预计算', `🔄 方案${schemeId} 开始计算...`);

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

        // 计算每个权重配置的概率
        let successCount = 0;
        for (const weightConfigId of weightConfigsToCalculate) {
            try {
                const result = calculateProbabilityFast(weightConfigId, schemeId);
                logger.info('概率预计算', `✅ 权重${weightConfigId} RTP:${result.rtp.toFixed(2)}%`);
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
 */
export async function warmupAllProbabilityCache(): Promise<void> {
    logger.info('缓存预热', '🔥 开始预热所有场次的概率缓存...');

    try {
        const { slotQueries, advancedSlotQueries, supremeSlotQueries, rewardConfigQueries } = await import('../database');

        // 获取所有场次的配置
        const normalConfig = slotQueries.getConfig.get();
        const advancedConfig = advancedSlotQueries.getAdvancedConfig.get();
        const supremeConfig = supremeSlotQueries.getConfig.get();

        // 收集所有需要计算的 (weightConfigId, schemeId) 组合
        const combinations = new Set<string>();

        if (normalConfig) {
            const key = `${normalConfig.weight_config_id || 1}-${normalConfig.reward_scheme_id || 1}`;
            combinations.add(key);
            logger.debug('缓存预热', `初级场: 权重${normalConfig.weight_config_id || 1}, 方案${normalConfig.reward_scheme_id || 1}`);
        }

        if (advancedConfig) {
            const key = `${advancedConfig.weight_config_id || 1}-${advancedConfig.reward_scheme_id || 1}`;
            combinations.add(key);
            logger.debug('缓存预热', `高级场: 权重${advancedConfig.weight_config_id || 1}, 方案${advancedConfig.reward_scheme_id || 1}`);
        }

        if (supremeConfig) {
            const key = `${supremeConfig.weight_config_id || 1}-${supremeConfig.reward_scheme_id || 1}`;
            combinations.add(key);
            logger.debug('缓存预热', `至尊场: 权重${supremeConfig.weight_config_id || 1}, 方案${supremeConfig.reward_scheme_id || 1}`);
        }

        // 如果没有任何配置，使用默认值
        if (combinations.size === 0) {
            combinations.add('1-1');
            logger.debug('缓存预热', '使用默认配置: 权重1, 方案1');
        }

        // 计算每个组合的概率
        let successCount = 0;
        let totalCount = 0;

        for (const key of combinations) {
            const [weightConfigId, schemeId] = key.split('-').map(Number);
            totalCount++;

            try {
                // 检查方案是否存在
                const scheme = rewardConfigQueries.getSchemeById.get(schemeId);
                if (!scheme) {
                    logger.warn('缓存预热', `⚠️ 方案${schemeId}不存在，跳过`);
                    continue;
                }

                // 计算并缓存
                const result = calculateProbabilityFast(weightConfigId, schemeId);
                logger.info('缓存预热', `✅ 权重${weightConfigId} + 方案${schemeId} → RTP:${result.rtp.toFixed(2)}%`);
                successCount++;
            } catch (error: any) {
                logger.error('缓存预热', `❌ 权重${weightConfigId} + 方案${schemeId} 失败: ${error.message}`);
            }
        }

        logger.info('缓存预热', `🎉 完成 ${successCount}/${totalCount} 个场次的概率缓存预热`);
    } catch (error: any) {
        logger.error('缓存预热', `预热失败: ${error.message}`);
        // 不抛出异常，避免影响应用启动
    }
}

