/**
 * 掉落配置服务
 * 统一管理所有场次的物品掉落规则
 */

import { addTicket, addFragment } from './advanced-slot';
import { addSupremeToken, addSupremeFragment } from './supreme-slot';
import { logger } from '../utils/logger';

/**
 * 掉落配置接口
 */
export interface DropConfig {
    id?: number;
    slot_mode: 'normal' | 'advanced' | 'supreme';
    trigger_rule_name: string;
    drop_item_type: 'ticket' | 'fragment' | 'supreme_token' | 'supreme_fragment';
    drop_probability: number;
    drop_count: number;
    is_active: number;
    priority: number;
    description?: string;
    created_at: number;
    updated_at: number;
}

/**
 * 掉落结果
 */
export interface DropResult {
    dropped: boolean;
    items: Array<{
        type: string;
        count: number;
        triggered: boolean;
        probability: number;
    }>;
}

/**
 * 获取所有掉落配置
 */
export async function getAllDropConfigs(): Promise<DropConfig[]> {
    const { dropConfigQueries } = await import('../database');
    return dropConfigQueries.getAll.all();
}

/**
 * 根据场次获取掉落配置
 */
export async function getDropConfigsByMode(slotMode: string): Promise<DropConfig[]> {
    const { dropConfigQueries } = await import('../database');
    return dropConfigQueries.getByMode.all(slotMode);
}

/**
 * 根据场次和规则名称获取掉落配置
 */
export async function getDropConfigsByRule(slotMode: string, ruleName: string): Promise<DropConfig[]> {
    const { dropConfigQueries } = await import('../database');
    return dropConfigQueries.getByModeAndRule.all(slotMode, ruleName);
}

/**
 * 处理掉落逻辑
 */
export async function handleDrops(
    linuxDoId: string,
    username: string,
    slotMode: string,
    ruleName: string
): Promise<DropResult> {
    const configs = await getDropConfigsByRule(slotMode, ruleName);
    
    if (!configs || configs.length === 0) {
        return { dropped: false, items: [] };
    }
    
    const result: DropResult = {
        dropped: false,
        items: []
    };
    
    // 遍历所有配置（一个规则可能掉落多种物品）
    for (const config of configs) {
        const triggered = Math.random() < config.drop_probability;
        
        result.items.push({
            type: config.drop_item_type,
            count: config.drop_count,
            triggered,
            probability: config.drop_probability
        });
        
        if (triggered) {
            result.dropped = true;
            
            // 执行掉落
            switch (config.drop_item_type) {
                case 'ticket':
                    const ticketResult = addTicket(linuxDoId, config.drop_count);
                    logger.info('掉落系统', `🎟️ ${username} 从 ${ruleName} 获得 ${config.drop_count}张入场券 (${config.drop_probability * 100}%概率)`);
                    if (!ticketResult.success) {
                        logger.warn('掉落系统', `⚠️ ${ticketResult.message}`);
                    }
                    break;

                case 'fragment':
                    addFragment(linuxDoId, config.drop_count);
                    logger.info('掉落系统', `🍀 ${username} 从 ${ruleName} 获得 ${config.drop_count}个碎片 (${config.drop_probability * 100}%概率)`);
                    break;

                case 'supreme_token':
                    const tokenResult = addSupremeToken(linuxDoId, config.drop_count);
                    logger.info('掉落系统', `💎 ${username} 从 ${ruleName} 获得 ${config.drop_count}个至尊令牌 (${config.drop_probability * 100}%概率)`);
                    if (!tokenResult.success) {
                        logger.warn('掉落系统', `⚠️ ${tokenResult.message}`);
                    }
                    break;

                case 'supreme_fragment':
                    addSupremeFragment(linuxDoId, config.drop_count);
                    logger.info('掉落系统', `💠 ${username} 从 ${ruleName} 获得 ${config.drop_count}个至尊碎片 (${config.drop_probability * 100}%概率)`);
                    break;
            }
        }
    }
    
    return result;
}

/**
 * 创建掉落配置
 */
export async function createDropConfig(config: Omit<DropConfig, 'id' | 'created_at' | 'updated_at'>): Promise<{ success: boolean; message: string; id?: number }> {
    const now = Date.now();
    
    try {
        const { dropConfigQueries } = await import('../database');
        
        const result = dropConfigQueries.insert.run(
            config.slot_mode,
            config.trigger_rule_name,
            config.drop_item_type,
            config.drop_probability,
            config.drop_count || 1,
            config.is_active !== undefined ? config.is_active : 1,
            config.priority || 0,
            config.description || null,
            now,
            now
        );
        
        console.log('[掉落配置] 创建成功:', {
            mode: config.slot_mode,
            rule: config.trigger_rule_name,
            item: config.drop_item_type,
            probability: config.drop_probability
        });
        
        return {
            success: true,
            message: '掉落配置已创建',
            id: result?.lastInsertRowid as number
        };
    } catch (error: any) {
        console.error('[掉落配置] 创建失败:', error);
        
        // 检查是否是唯一约束冲突
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message?.includes('UNIQUE constraint')) {
            return {
                success: false,
                message: '该场次的该规则已配置此物品掉落，请勿重复添加'
            };
        }
        
        return {
            success: false,
            message: '创建失败: ' + (error.message || '未知错误')
        };
    }
}

/**
 * 更新掉落配置
 */
export async function updateDropConfig(id: number, config: Omit<DropConfig, 'id' | 'created_at' | 'updated_at'>): Promise<{ success: boolean; message: string }> {
    try {
        const { dropConfigQueries } = await import('../database');
        const now = Date.now();
        
        dropConfigQueries.update.run(
            config.slot_mode,
            config.trigger_rule_name,
            config.drop_item_type,
            config.drop_probability,
            config.drop_count || 1,
            config.is_active !== undefined ? config.is_active : 1,
            config.priority || 0,
            config.description || null,
            now,
            id
        );
        
        return {
            success: true,
            message: '掉落配置已更新'
        };
    } catch (error: any) {
        console.error('[掉落配置] 更新失败:', error);
        return {
            success: false,
            message: '更新失败: ' + error.message
        };
    }
}

/**
 * 删除掉落配置
 */
export async function deleteDropConfig(id: number): Promise<{ success: boolean; message: string }> {
    try {
        const { dropConfigQueries } = await import('../database');
        
        dropConfigQueries.delete.run(id);
        
        return {
            success: true,
            message: '掉落配置已删除'
        };
    } catch (error: any) {
        console.error('[掉落配置] 删除失败:', error);
        return {
            success: false,
            message: '删除失败: ' + error.message
        };
    }
}

