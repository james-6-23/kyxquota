/**
 * 概率计算器
 * 提供快速估算和蒙特卡洛模拟两种计算方式
 */

import { rewardConfigQueries, weightConfigQueries } from '../database';

// 符号列表
const SYMBOLS = ['m', 't', 'n', 'j', 'lq', 'bj', 'zft', 'bdk', 'lsh'];

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
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存有效期

/**
 * 生成缓存键
 */
function getCacheKey(weightConfigId: number, rewardSchemeId: number, method: 'fast' | 'monte-carlo'): string {
    return `${weightConfigId}-${rewardSchemeId}-${method}`;
}

/**
 * 从缓存获取结果
 */
function getFromCache(weightConfigId: number, rewardSchemeId: number, method: 'fast' | 'monte-carlo'): ProbabilityResult | null {
    const key = getCacheKey(weightConfigId, rewardSchemeId, method);
    const entry = probabilityCache.get(key);
    
    if (!entry) {
        return null;
    }
    
    // 检查是否过期
    if (Date.now() - entry.timestamp > CACHE_TTL) {
        probabilityCache.delete(key);
        console.log(`[缓存] 过期并删除: ${key}`);
        return null;
    }
    
    console.log(`[缓存] 命中: ${key}`);
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
    console.log(`[缓存] 已保存: ${key}, 当前缓存数: ${probabilityCache.size}`);
}

/**
 * 清理过期缓存（定期调用）
 */
export function cleanExpiredCache(): void {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of probabilityCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL) {
            probabilityCache.delete(key);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`[缓存清理] 删除 ${cleaned} 个过期项，剩余 ${probabilityCache.size} 个`);
    }
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
        weightConfig.weight_lsh
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
    
    // 🔥 安全解析 required_symbols
    let requiredArr: string[] = [];
    if (required_symbols) {
        try {
            // 如果已经是数组，直接使用
            if (Array.isArray(required_symbols)) {
                requiredArr = required_symbols;
            } else if (typeof required_symbols === 'string') {
                // 如果是字符串，尝试解析
                requiredArr = JSON.parse(required_symbols);
            }
        } catch (e) {
            console.error(`[规则匹配] "${rule_name}" JSON解析失败:`, required_symbols, e);
            return false;
        }
    }
    
    // 🔥 调试日志（仅在debug模式下）
    if (debug) {
        console.log(`[规则匹配] 检查规则 "${rule_name}":`, {
            symbols,
            match_pattern,
            match_count,
            required_symbols: requiredArr,
            rule
        });
    }
    
    let matched = false;
    
    // 🔥 处理匹配模式：兼容 "any" 和 "2-any" 两种格式
    let normalizedPattern = match_pattern;
    
    // 如果是 "2-any", "3-consecutive" 等格式，提取出基础模式
    if (match_pattern.includes('-')) {
        const parts = match_pattern.split('-');
        normalizedPattern = parts[1]; // 取 "any" 或 "consecutive"
        if (debug) {
            console.log(`  - 格式转换: "${match_pattern}" => "${normalizedPattern}"`);
        }
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
            if (debug) {
                console.log(`  - consecutive模式检查: 最大连续=${maxConsecutive}, 需要>=${match_count || 2}, 匹配=${matched}`);
            }
            break;
            
        case 'any':  // 任意位置相同
            const counts: Record<string, number> = {};
            symbols.forEach(s => counts[s] = (counts[s] || 0) + 1);
            const maxCount = Math.max(...Object.values(counts));
            matched = maxCount >= (match_count || 2);
            if (debug) {
                console.log(`  - any模式检查: 符号计数=`, counts, `最大=${maxCount}, 需要>=${match_count || 2}, 匹配=${matched}`);
            }
            break;
            
        case 'double_pair':  // 两对2连
            const pairCounts: Record<string, number> = {};
            symbols.forEach(s => pairCounts[s] = (pairCounts[s] || 0) + 1);
            const pairs = Object.values(pairCounts).filter(count => count >= 2);
            matched = pairs.length >= 2;
            if (debug) {
                console.log(`  - double_pair模式检查: 对数=${pairs.length}, 匹配=${matched}`);
            }
            break;
            
        default:
            if (debug) {
                console.warn(`  - 未知的匹配模式: ${match_pattern} (规范化后: ${normalizedPattern})`);
            }
            matched = false;
    }
    
    if (debug && matched) {
        console.log(`  ✅ 规则 "${rule_name}" 匹配成功！`);
    }
    
    return matched;
}

/**
 * 匹配规则（按优先级）
 */
function matchRuleByPriority(symbols: string[], schemeId: number, debug: boolean = false): {
    ruleName: string;
    multiplier: number;
    punishmentCount?: number;
} {
    // 1. 先检查律师函惩罚
    const lshCount = symbols.filter(s => s === 'lsh').length;
    if (lshCount > 0) {
        const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);
        const punishment = punishments.find(p => p.lsh_count === lshCount && p.is_active);
        if (punishment) {
            if (debug) {
                console.log(`  💥 律师函惩罚: ${lshCount}个 => -${punishment.deduct_multiplier}x`);
            }
            return {
                ruleName: `律师函×${lshCount}`,
                multiplier: -punishment.deduct_multiplier,
                punishmentCount: lshCount
            };
        }
    }
    
    // 2. 按优先级检查奖励规则
    const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
    const activeRules = rules.filter(r => r.is_active).sort((a, b) => b.priority - a.priority);
    
    if (debug) {
        console.log(`[匹配规则] 方案ID: ${schemeId}, 总规则: ${rules.length}, 激活规则: ${activeRules.length}`);
    }
    
    for (const rule of activeRules) {
        if (checkRuleMatch(symbols, rule, debug)) {
            return {
                ruleName: rule.rule_name,
                multiplier: rule.win_multiplier
            };
        }
    }
    
    // 3. 未中奖
    if (debug) {
        console.log(`  ❌ 未中奖`);
    }
    return {
        ruleName: '未中奖',
        multiplier: 0
    };
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
        console.log('[快速估算] 使用缓存结果');
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
    
    // 🔥 前10次模拟输出调试日志（帮助诊断规则匹配问题）
    let debugCount = 0;
    const maxDebug = 10;
    
    for (let i = 0; i < quickSimCount; i++) {
        const symbols = generateSymbols(weightConfig);
        const enableDebug = debugCount < maxDebug;
        const result = matchRuleByPriority(symbols, rewardSchemeId, enableDebug);
        
        if (enableDebug) {
            debugCount++;
            console.log(`[快速估算 #${debugCount}] 符号:`, symbols, `=> 结果: ${result.ruleName} (${result.multiplier}x)`);
        }
        
        // 排除律师函（已单独计算）
        if (!result.ruleName.includes('律师函')) {
            quickStats[result.ruleName] = (quickStats[result.ruleName] || 0) + 1;
        }
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

