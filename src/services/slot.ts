import { slotQueries } from '../database';

// 符号定义
const SYMBOLS = {
    SPECIAL_GROUP_1: ['j', 'n', 't', 'm'],
    SPECIAL_GROUP_2: ['bj', 'zft', 'bdk', 'lq'],
    PUNISHMENT: 'lsh',
    ALL: ['m', 't', 'n', 'j', 'lq', 'bj', 'zft', 'bdk', 'lsh']
};

// 默认符号权重配置（控制概率）
const DEFAULT_SYMBOL_WEIGHTS: Record<string, number> = {
    'm': 100,
    't': 100,
    'n': 100,
    'j': 100,
    'lq': 100,
    'bj': 100,
    'zft': 100,
    'bdk': 100,
    'lsh': 25  // 中度概率，约2.94%每个位置，至少1个约11.3%
};

// 从数据库获取符号权重
export function getSymbolWeights(): Record<string, number> {
    try {
        const weights = slotQueries.getWeights.get();
        if (weights) {
            return {
                'm': weights.weight_m,
                't': weights.weight_t,
                'n': weights.weight_n,
                'j': weights.weight_j,
                'lq': weights.weight_lq,
                'bj': weights.weight_bj,
                'zft': weights.weight_zft,
                'bdk': weights.weight_bdk,
                'lsh': weights.weight_lsh
            };
        }
    } catch (error) {
        console.error('获取符号权重失败，使用默认值:', error);
    }
    return DEFAULT_SYMBOL_WEIGHTS;
}

// 中奖类型
export enum WinType {
    SUPER_JACKPOT = 'super_jackpot',      // 256x 特殊顺序
    SPECIAL_COMBO = 'special_combo',      // 32x 特殊乱序
    QUAD = 'quad',                        // 16x 四连
    TRIPLE = 'triple',                    // 8x 三连
    DOUBLE = 'double',                    // 4x 双连
    PUNISHMENT = 'punishment',            // 0x 惩罚
    NONE = 'none'                         // 0x 未中奖
}

// 中奖类型中文名称
export const WIN_TYPE_NAMES: Record<WinType, string> = {
    [WinType.SUPER_JACKPOT]: '🏆 超级大奖',
    [WinType.SPECIAL_COMBO]: '💎 特殊组合',
    [WinType.QUAD]: '🎰 四连中奖',
    [WinType.TRIPLE]: '✨ 三连中奖',
    [WinType.DOUBLE]: '🎁 双连中奖',
    [WinType.PUNISHMENT]: '⚡ 惩罚',
    [WinType.NONE]: '❌ 未中奖'
};

/**
 * 加权随机抽取符号
 */
function getRandomSymbol(): string {
    const SYMBOL_WEIGHTS = getSymbolWeights(); // 每次从数据库获取最新权重
    const totalWeight = Object.values(SYMBOL_WEIGHTS).reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;

    for (const [symbol, weight] of Object.entries(SYMBOL_WEIGHTS)) {
        random -= weight;
        if (random <= 0) {
            return symbol;
        }
    }

    return 'm'; // 默认返回
}

/**
 * 生成4个随机符号
 */
export function generateSymbols(): string[] {
    return [
        getRandomSymbol(),
        getRandomSymbol(),
        getRandomSymbol(),
        getRandomSymbol()
    ];
}

/**
 * 统计符号出现次数
 */
function countSymbols(symbols: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    symbols.forEach(s => {
        counts[s] = (counts[s] || 0) + 1;
    });
    return counts;
}

/**
 * 判断两个数组是否完全相等（顺序也相同）
 */
function arraysEqual(a: string[], b: string[]): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 判断数组是否包含目标数组的所有元素（不考虑顺序）
 */
function containsAll(arr: string[], target: string[]): boolean {
    return target.every(t => arr.includes(t));
}

/**
 * 计算中奖结果
 */
export function calculateWin(symbols: string[]): {
    winType: WinType;
    multiplier: number;
    freeSpinAwarded: boolean;
    punishmentCount?: number;  // 律师函数量
    shouldBan?: boolean;       // 是否需要禁止抽奖
} {
    // 1. 惩罚规则（最高优先级）
    const punishmentCount = symbols.filter(s => s === SYMBOLS.PUNISHMENT).length;

    if (punishmentCount > 0) {
        // 梯度惩罚：1个扣1倍，2个扣2倍，3个扣3倍，4个扣4倍
        return {
            winType: WinType.PUNISHMENT,
            multiplier: -punishmentCount,  // 负数倍率表示扣除
            freeSpinAwarded: false,
            punishmentCount: punishmentCount,
            shouldBan: punishmentCount >= 3  // 3个及以上禁止抽奖
        };
    }

    // 2. 特殊组合规则 - 检查 j→n→t→m 顺序
    if (arraysEqual(symbols, ['j', 'n', 't', 'm'])) {
        return {
            winType: WinType.SUPER_JACKPOT,
            multiplier: 256,
            freeSpinAwarded: false
        };
    }

    // 检查 bj→zft→bdk→lq 顺序
    if (arraysEqual(symbols, ['bj', 'zft', 'bdk', 'lq'])) {
        return {
            winType: WinType.SUPER_JACKPOT,
            multiplier: 256,
            freeSpinAwarded: false
        };
    }

    // 检查特殊组合乱序（包含所有4个但不按顺序）
    if (containsAll(symbols, SYMBOLS.SPECIAL_GROUP_1)) {
        return {
            winType: WinType.SPECIAL_COMBO,
            multiplier: 32,
            freeSpinAwarded: false
        };
    }

    if (containsAll(symbols, SYMBOLS.SPECIAL_GROUP_2)) {
        return {
            winType: WinType.SPECIAL_COMBO,
            multiplier: 32,
            freeSpinAwarded: false
        };
    }

    // 3. 基础匹配规则
    const symbolCounts = countSymbols(symbols);
    const maxCount = Math.max(...Object.values(symbolCounts));

    if (maxCount === 4) {
        return {
            winType: WinType.QUAD,
            multiplier: 16,  // 2^4
            freeSpinAwarded: true  // 奖励1次免费
        };
    }

    if (maxCount === 3) {
        return {
            winType: WinType.TRIPLE,
            multiplier: 8,  // 2^3
            freeSpinAwarded: true  // 奖励1次免费
        };
    }

    if (maxCount === 2) {
        return {
            winType: WinType.DOUBLE,
            multiplier: 4,  // 2^2
            freeSpinAwarded: false
        };
    }

    // 未中奖
    return {
        winType: WinType.NONE,
        multiplier: 0,
        freeSpinAwarded: false
    };
}

/**
 * 获取今日日期字符串
 */
export function getTodayDate(): string {
    const now = new Date();
    return now.toISOString().split('T')[0]!;
}

/**
 * 获取老虎机配置
 */
export function getSlotConfig() {
    return slotQueries.getConfig.get();
}

/**
 * 获取用户今日游玩次数
 */
export function getUserTodaySpins(linuxDoId: string): number {
    const today = getTodayDate();
    const result = slotQueries.getTodaySpins.get(linuxDoId, today);
    return result?.count || 0;
}

/**
 * 获取用户免费次数和禁止状态
 */
export function getUserFreeSpins(linuxDoId: string): number {
    const result = slotQueries.getFreeSpin.get(linuxDoId);
    return result?.free_spins || 0;
}

/**
 * 检查用户是否被禁止抽奖
 */
export function isUserBanned(linuxDoId: string): { banned: boolean; bannedUntil: number } {
    const result = slotQueries.getFreeSpin.get(linuxDoId);
    const now = Date.now();
    const bannedUntil = result?.banned_until || 0;
    return {
        banned: bannedUntil > now,
        bannedUntil: bannedUntil
    };
}

/**
 * 设置用户禁止抽奖
 */
export function banUserFromSlot(linuxDoId: string, hours: number) {
    const now = Date.now();
    const bannedUntil = now + (hours * 3600000); // 转换为毫秒
    slotQueries.setBannedUntil.run(linuxDoId, bannedUntil, now, bannedUntil, now);
    console.log(`[惩罚] 用户 ${linuxDoId} 被禁止抽奖至 ${new Date(bannedUntil).toLocaleString('zh-CN')}`);
}

/**
 * 增加用户免费次数
 */
export function addUserFreeSpins(linuxDoId: string, count: number = 1) {
    try {
        console.log(`[增加免费次数] ====== 开始增加 ======`);
        console.log(`[增加免费次数] 用户ID: ${linuxDoId}`);
        console.log(`[增加免费次数] 增加数量: ${count}`);

        // 查询增加前的状态
        const beforeRecord = slotQueries.getFreeSpin.get(linuxDoId);
        console.log(`[增加免费次数] 增加前状态:`, JSON.stringify(beforeRecord, null, 2));

        const now = Date.now();
        for (let i = 0; i < count; i++) {
            const result = slotQueries.incrementFreeSpin.run(linuxDoId, now, now);
            console.log(`[增加免费次数] 第${i + 1}次增加结果:`, JSON.stringify(result, null, 2));
        }

        // 验证增加后的状态
        const afterRecord = slotQueries.getFreeSpin.get(linuxDoId);
        console.log(`[增加免费次数] 增加后状态:`, JSON.stringify(afterRecord, null, 2));
        console.log(`[增加免费次数] ✅ 成功！免费次数从 ${beforeRecord?.free_spins || 0} 增加到 ${afterRecord?.free_spins || 0}`);
    } catch (error) {
        console.error(`[增加免费次数] ⚠️ 异常:`, error);
        console.error(`[增加免费次数] 错误堆栈:`, error instanceof Error ? error.stack : '无堆栈');
    }
}

/**
 * 减少用户免费次数
 */
export function useUserFreeSpin(linuxDoId: string): boolean {
    try {
        console.log(`[扣除免费次数] ====== 开始扣除 ======`);
        console.log(`[扣除免费次数] 用户ID: ${linuxDoId}`);

        const now = Date.now();
        console.log(`[扣除免费次数] 时间戳: ${now}`);

        // 先检查当前免费次数
        const currentRecord = slotQueries.getFreeSpin.get(linuxDoId);
        console.log(`[扣除免费次数] 数据库查询结果:`, JSON.stringify(currentRecord, null, 2));

        if (!currentRecord) {
            console.error(`[扣除免费次数] ❌ 没有记录 - 用户从未获得过免费次数`);
            return false;
        }

        if (currentRecord.free_spins <= 0) {
            console.error(`[扣除免费次数] ❌ 次数不足 - 当前: ${currentRecord.free_spins}`);
            return false;
        }

        console.log(`[扣除免费次数] ✓ 检查通过，当前有 ${currentRecord.free_spins} 次免费机会`);
        console.log(`[扣除免费次数] 执行 SQL: UPDATE user_free_spins SET free_spins = free_spins - 1, updated_at = ${now} WHERE linux_do_id = '${linuxDoId}' AND free_spins > 0`);

        const result = slotQueries.decrementFreeSpin.run(now, linuxDoId);
        console.log(`[扣除免费次数] SQL 执行结果:`, JSON.stringify(result, null, 2));
        console.log(`[扣除免费次数] 受影响行数: ${result.changes}`);

        if (result.changes > 0) {
            console.log(`[扣除免费次数] ✅ 成功！用户 ${linuxDoId} 剩余: ${currentRecord.free_spins - 1}`);

            // 验证扣除结果
            const afterRecord = slotQueries.getFreeSpin.get(linuxDoId);
            console.log(`[扣除免费次数] 扣除后验证:`, JSON.stringify(afterRecord, null, 2));

            return true;
        }

        console.error(`[扣除免费次数] ❌ UPDATE 失败，changes=0 - 可能被其他请求抢先扣除了`);
        return false;
    } catch (error) {
        console.error(`[扣除免费次数] ⚠️ 异常发生:`, error);
        console.error(`[扣除免费次数] 错误堆栈:`, error instanceof Error ? error.stack : '无堆栈');
        return false;
    }
}

/**
 * 保存游戏记录
 */
export function saveGameRecord(
    linuxDoId: string,
    username: string,
    linuxDoUsername: string | null | undefined,
    betAmount: number,
    symbols: string[],
    winType: WinType,
    multiplier: number,
    winAmount: number,
    freeSpinAwarded: boolean,
    isFreeSpin: boolean
) {
    const now = Date.now();
    const today = getTodayDate();

    slotQueries.insertRecord.run(
        linuxDoId,
        username,
        linuxDoUsername || null,
        betAmount,
        JSON.stringify(symbols),
        winType,
        multiplier,
        winAmount,
        freeSpinAwarded ? 1 : 0,
        isFreeSpin ? 1 : 0,
        now,
        today
    );
}

/**
 * 获取用户游戏记录
 */
export function getUserRecords(linuxDoId: string) {
    return slotQueries.getRecordsByUser.all(linuxDoId);
}

/**
 * 获取用户今日统计
 */
export function getUserTodayStats(linuxDoId: string) {
    const today = getTodayDate();
    const result = slotQueries.getTodayStats.get(linuxDoId, today);
    return {
        totalBet: result?.total_bet || 0,
        totalWin: result?.total_win || 0,
        count: result?.count || 0
    };
}

/**
 * 更新用户总统计（用于排行榜）
 */
export function updateUserTotalStats(
    linuxDoId: string,
    username: string,
    avatarUrl: string,
    betAmount: number,
    winAmount: number,
    winType: WinType
) {
    const now = Date.now();

    console.log('[更新统计] 用户:', username, 'Avatar URL:', avatarUrl);

    // 获取现有统计
    const currentStats = slotQueries.getUserStats.get(linuxDoId);

    if (currentStats) {
        // 更新统计
        const newTotalSpins = currentStats.total_spins + 1;
        const newTotalBet = currentStats.total_bet + betAmount;
        const newTotalWin = currentStats.total_win + winAmount;
        const newBiggestWin = Math.max(currentStats.biggest_win || 0, winAmount);
        const newBiggestWinType = winAmount > (currentStats.biggest_win || 0) ? winType : currentStats.biggest_win_type;

        slotQueries.updateUserStats.run(
            linuxDoId,
            username,
            avatarUrl,
            newTotalSpins,
            newTotalBet,
            newTotalWin,
            newBiggestWin,
            newBiggestWinType,
            now
        );
    } else {
        // 创建新统计
        slotQueries.updateUserStats.run(
            linuxDoId,
            username,
            avatarUrl,
            1, // total_spins
            betAmount,
            winAmount,
            winAmount, // biggest_win
            winType,
            now
        );
    }
}

/**
 * 获取排行榜
 */
export function getLeaderboard(limit: number = 100) {
    return slotQueries.getLeaderboard.all(limit);
}

/**
 * 获取用户排名
 */
export function getUserRank(linuxDoId: string): number {
    const result = slotQueries.getUserRank.get(linuxDoId);
    return result?.rank || 0;
}

/**
 * 获取用户总统计
 */
export function getUserTotalStats(linuxDoId: string) {
    return slotQueries.getUserStats.get(linuxDoId);
}

