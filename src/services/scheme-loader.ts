/**
 * 配置方案加载器
 * 统一加载初级场、高级场、至尊场的权重和奖励配置
 */

import { slotQueries, advancedSlotQueries, supremeSlotQueries, weightConfigQueries, rewardConfigQueries } from '../database';
import logger from '../utils/logger';

/**
 * 获取初级场的权重配置
 */
export function getNormalSlotWeights(): any {
    const config = slotQueries.getConfig.get();
    const weightConfigId = config?.weight_config_id || 1;
    const weightConfig = weightConfigQueries.getById.get(weightConfigId);

    if (!weightConfig) {
        logger.warn('初级场', '权重配置不存在，使用默认值');
        return {
            weight_m: 100,
            weight_t: 100,
            weight_n: 100,
            weight_j: 100,
            weight_lq: 100,
            weight_bj: 100,
            weight_zft: 100,
            weight_bdk: 100,
            weight_lsh: 25,
            weight_man: 25
        };
    }

    return weightConfig;
}

/**
 * 获取初级场的奖励规则
 */
export function getNormalSlotRewardRules(): { rules: any[]; punishments: any[] } {
    const config = slotQueries.getConfig.get();
    const schemeId = config?.reward_scheme_id || 1;
    const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
    const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);

    return {
        rules: rules || [],
        punishments: punishments || []
    };
}

/**
 * 获取高级场的权重配置
 */
export function getAdvancedSlotWeights(): any {
    const config = advancedSlotQueries.getAdvancedConfig.get();
    const weightConfigId = config?.weight_config_id || 1;
    const weightConfig = weightConfigQueries.getById.get(weightConfigId);

    if (!weightConfig) {
        logger.warn('高级场', '权重配置不存在，使用默认值');
        return {
            weight_m: 100,
            weight_t: 100,
            weight_n: 100,
            weight_j: 100,
            weight_lq: 100,
            weight_bj: 100,
            weight_zft: 100,
            weight_bdk: 100,
            weight_lsh: 50,
            weight_man: 30
        };
    }

    return weightConfig;
}

/**
 * 获取高级场的奖励规则
 */
export function getAdvancedSlotRewardRules(): { rules: any[]; punishments: any[] } {
    const config = advancedSlotQueries.getAdvancedConfig.get();
    const schemeId = config?.reward_scheme_id || 1;
    const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
    const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);

    return {
        rules: rules || [],
        punishments: punishments || []
    };
}

/**
 * 获取至尊场的权重配置
 */
export function getSupremeSlotWeights(): any {
    const config = supremeSlotQueries.getConfig.get();
    const weightConfigId = config?.weight_config_id || 1;
    const weightConfig = weightConfigQueries.getById.get(weightConfigId);

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
            weight_lsh: 25,
            weight_man: 25
        };
    }

    return weightConfig;
}

/**
 * 获取至尊场的奖励规则
 */
export function getSupremeSlotRewardRules(): { rules: any[]; punishments: any[] } {
    const config = supremeSlotQueries.getConfig.get();
    const schemeId = config?.reward_scheme_id || 1;
    const rules = rewardConfigQueries.getRulesByScheme.all(schemeId);
    const punishments = rewardConfigQueries.getPunishmentsByScheme.all(schemeId);

    return {
        rules: rules || [],
        punishments: punishments || []
    };
}

