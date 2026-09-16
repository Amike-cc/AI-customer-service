import { useEffect, useState, useRef, useCallback, useId } from 'react';
import { MapPin, Clock, Shield, Truck, Gift, Tag, Check, Loader2, Headphones, Sparkles } from 'lucide-react';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { useToast } from '../common/Toast';
import type { ShopBusinessConfig, ShopPersona, PersonaTone } from '../../types/api';
import styles from './ShopBusinessConfigEditor.module.css';

/** 常见快递公司选项 */
const EXPRESS_OPTIONS = [
  '顺丰速运', '中通快递', '圆通速递', '申通快递', '韵达快递',
  '百世快递', '邮政EMS', '京东物流', '极兔速递', '德邦快递',
];

/** 常见主营类目选项 */
const CATEGORY_OPTIONS = [
  { value: '', label: '请选择主营类目' },
  { value: '服装服饰', label: '服装服饰' },
  { value: '鞋包配饰', label: '鞋包配饰' },
  { value: '美妆个护', label: '美妆个护' },
  { value: '食品生鲜', label: '食品生鲜' },
  { value: '家居日用', label: '家居日用' },
  { value: '数码电器', label: '数码电器' },
  { value: '母婴玩具', label: '母婴玩具' },
  { value: '运动户外', label: '运动户外' },
  { value: '图书文娱', label: '图书文娱' },
  { value: '其他', label: '其他' },
];

/** 客服专员映射行配置（角色 → 中文名 → 场景说明，与 src/tools/types.ts 的 AgentRole 保持一致） */
const AGENT_MAPPING_ROWS: Array<{ role: 'after_sales' | 'logistics' | 'pre_sales' | 'general'; name: string; scene: string }> = [
  { role: 'after_sales', name: '售后专员', scene: '退货退款 / 质量问题 / 投诉' },
  { role: 'logistics', name: '物流专员', scene: '快递查询 / 催发货 / 改地址' },
  { role: 'pre_sales', name: '售前专员', scene: '商品咨询 / 尺码推荐 / 活动' },
  { role: 'general', name: '通用客服', scene: '复杂问题 / 跨类目 / 混合问题' },
];

/** 语气风格选项 */
const TONE_OPTIONS: Array<{ value: PersonaTone; label: string; description: string }> = [
  { value: 'professional', label: '专业礼貌', description: '规范用语，简洁高效' },
  { value: 'friendly', label: '亲切友好', description: '适度口语化，多用"亲"' },
  { value: 'lively', label: '活泼开朗', description: '多用语气词和感叹号' },
  { value: 'cute', label: '可爱俏皮', description: '多用叠词和颜文字' },
];

/** 默认人设（与后端 DEFAULT_PERSONA 一致） */
const DEFAULT_PERSONA: ShopPersona = {
  tone: 'professional',
  nickname: '',
  catchphrases: [],
  useEmojis: false,
  description: '',
};

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface ShopBusinessConfigEditorProps {
  shopId: string;
}

function persistBusinessConfig(config: ShopBusinessConfig) {
  return window.api.shop.updateBusinessConfig(config.shopId, {
    deliveryAddress: config.deliveryAddress,
    deliveryTime: config.deliveryTime,
    freightInsurance: config.freightInsurance,
    expressCompanies: config.expressCompanies,
    freeShipping: config.freeShipping,
    freeShippingCondition: config.freeShippingCondition,
    mainCategory: config.mainCategory,
    agentMappings: config.agentMappings ?? {},
    persona: config.persona ?? DEFAULT_PERSONA,
  });
}

/**
 * 店铺店铺配置编辑器（作为弹窗内容使用）
 *
 * 接收 shopId，自动加载对应店铺的店铺配置，并以 debounce 方式实时保存。
 */
export function ShopBusinessConfigEditor({ shopId }: ShopBusinessConfigEditorProps) {
  const [config, setConfig] = useState<ShopBusinessConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const toast = useToast();
  const fieldIdPrefix = useId();
  const mainCategoryId = `${fieldIdPrefix}-main-category`;
  const deliveryAddressId = `${fieldIdPrefix}-delivery-address`;
  const deliveryTimeId = `${fieldIdPrefix}-delivery-time`;
  const freeShippingConditionId = `${fieldIdPrefix}-free-shipping-condition`;

  // debounce 保存定时器
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最新配置快照（避免闭包陈旧引用）
  const latestConfigRef = useRef<ShopBusinessConfig | null>(null);
  // 加载请求竞态守卫：快速切换店铺时旧响应不得覆盖新店铺配置
  const loadRequestRef = useRef(0);

  // shopId 变化时加载配置
  useEffect(() => {
    if (!shopId) {
      setConfig(null);
      return;
    }
    void loadConfig(shopId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  const loadConfig = async (id: string) => {
    const requestId = ++loadRequestRef.current;
    setConfigLoading(true);
    setSaveStatus('idle');
    setErrors({});
    try {
      const result = await window.api.shop.getBusinessConfig(id);
      if (loadRequestRef.current !== requestId) return; // 已切换到其他店铺，丢弃过期响应
      if (result.ok && result.config) {
        setConfig(result.config);
        latestConfigRef.current = result.config;
      } else {
        toast.show('error', '加载配置失败: ' + (result.error ?? '未知错误'));
      }
    } catch (err) {
      if (loadRequestRef.current !== requestId) return;
      toast.show('error', '加载配置失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (loadRequestRef.current === requestId) setConfigLoading(false);
    }
  };

  // 验证单个字段
  const validateField = (field: string, value: unknown): string => {
    if (field === 'deliveryAddress' && typeof value === 'string' && value.length > 200) {
      return '发货地址不能超过 200 字';
    }
    if (field === 'deliveryTime' && typeof value === 'string' && value.length > 50) {
      return '发货时长不能超过 50 字';
    }
    if (field === 'freeShippingCondition' && typeof value === 'string' && value.length > 100) {
      return '包邮条件不能超过 100 字';
    }
    if (field === 'mainCategory' && typeof value === 'string' && value.length > 50) {
      return '主营类目不能超过 50 字';
    }
    return '';
  };

  // 保存配置到后端（debounce）
  const saveConfig = useCallback((newConfig: ShopBusinessConfig) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    setSaveStatus('saving');
    saveTimerRef.current = setTimeout(async () => {
      saveTimerRef.current = null;
      try {
        const result = await persistBusinessConfig(newConfig);
        if (result.ok) {
          setSaveStatus('saved');
          setTimeout(() => setSaveStatus('idle'), 2000);
        } else {
          setSaveStatus('error');
          toast.show('error', '保存失败: ' + (result.error ?? '未知错误'));
        }
      } catch (err) {
        setSaveStatus('error');
        toast.show('error', '保存失败: ' + (err instanceof Error ? err.message : String(err)));
      }
    }, 600);
  }, [toast]);

  // 更新字段并触发保存
  const updateField = (field: keyof ShopBusinessConfig, value: unknown) => {
    if (!config) return;
    const error = validateField(field, value);
    setErrors((prev) => ({ ...prev, [field]: error }));
    if (error) return;

    const newConfig = { ...config, [field]: value } as ShopBusinessConfig;
    setConfig(newConfig);
    latestConfigRef.current = newConfig;
    saveConfig(newConfig);
  };

  // 切换快递公司选中状态
  const toggleExpress = (company: string) => {
    if (!config) return;
    const current = config.expressCompanies || [];
    const newList = current.includes(company)
      ? current.filter((c) => c !== company)
      : [...current, company];
    updateField('expressCompanies', newList);
  };

  // 更新单个角色的飞鸽客服映射并触发保存（空字符串视为未配置，删除该键）
  const updateAgentMapping = (role: string, agentName: string) => {
    if (!config) return;
    // 单个账号名长度限制 50 字（与后端校验一致）
    if (agentName.length > 50) {
      toast.show('error', '飞鸽客服账号名不能超过 50 字');
      return;
    }
    const currentMappings = config.agentMappings ?? {};
    const newMappings = { ...currentMappings, [role]: agentName.trim() };
    // 空字符串视为未配置（删除该键）
    if (!agentName.trim()) {
      delete newMappings[role];
    }
    const newConfig = { ...config, agentMappings: newMappings } as ShopBusinessConfig;
    setConfig(newConfig);
    latestConfigRef.current = newConfig;
    saveConfig(newConfig);
  };

  // 更新人设字段并触发保存
  const updatePersonaField = (field: keyof ShopPersona, value: unknown) => {
    if (!config) return;
    const currentPersona = config.persona ?? DEFAULT_PERSONA;
    // 字段长度校验（与后端校验一致）
    if (field === 'nickname' && typeof value === 'string' && value.length > 20) {
      toast.show('error', '客服昵称不能超过 20 字');
      return;
    }
    if (field === 'description' && typeof value === 'string' && value.length > 200) {
      toast.show('error', '自定义人设描述不能超过 200 字');
      return;
    }
    if (field === 'catchphrases' && Array.isArray(value) && value.length > 5) {
      toast.show('error', '口头禅最多 5 个');
      return;
    }
    const newPersona = { ...currentPersona, [field]: value } as ShopPersona;
    const newConfig = { ...config, persona: newPersona } as ShopBusinessConfig;
    setConfig(newConfig);
    latestConfigRef.current = newConfig;
    saveConfig(newConfig);
  };

  // 更新口头禅列表（按回车或逗号分隔）
  const updateCatchphrases = (text: string) => {
    if (!config) return;
    // 按中英文逗号或换行分割，去重去空，限制 5 个，每个最多 20 字
    const list = text
      .split(/[,\n，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 5)
      .map((s) => s.slice(0, 20));
    updatePersonaField('catchphrases', list);
  };

  // 弹窗在防抖窗口内关闭时立即补写最后一次快照，避免最后输入静默丢失。
  useEffect(() => {
    return () => {
      if (!saveTimerRef.current) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      const pendingConfig = latestConfigRef.current;
      if (pendingConfig) {
        void persistBusinessConfig(pendingConfig).catch(() => {
          // 组件已卸载，错误由主进程日志记录；避免产生未处理 Promise。
        });
      }
    };
  }, []);

  if (configLoading) return <LoadingSpinner size={24} />;

  if (!config) {
    return <div className={styles.emptyState}>配置加载失败，请重试</div>;
  }

  return (
    <div className={styles.editorBody}>
      {/* 主营类目 */}
      <div className={styles.formGroup}>
        <label htmlFor={mainCategoryId}>
          <Tag size={14} />
          主营类目
        </label>
        <Select
          id={mainCategoryId}
          aria-describedby={`${mainCategoryId}-hint${errors.mainCategory ? ` ${mainCategoryId}-error` : ''}`}
          aria-invalid={Boolean(errors.mainCategory)}
          options={CATEGORY_OPTIONS}
          value={config.mainCategory}
          onChange={(e) => updateField('mainCategory', e.target.value)}
        />
        <div id={`${mainCategoryId}-hint`} className={styles.hint}>选择店铺的主要经营类目，帮助 AI 更准确理解业务范围</div>
        {errors.mainCategory && <div id={`${mainCategoryId}-error`} className={styles.error} role="alert">{errors.mainCategory}</div>}
      </div>

      {/* 发货地址 */}
      <div className={styles.formGroup}>
        <label htmlFor={deliveryAddressId}>
          <MapPin size={14} />
          发货地址
        </label>
        <Input
          id={deliveryAddressId}
          type="text"
          aria-describedby={`${deliveryAddressId}-hint${errors.deliveryAddress ? ` ${deliveryAddressId}-error` : ''}`}
          aria-invalid={Boolean(errors.deliveryAddress)}
          placeholder="如：浙江金华义乌市"
          value={config.deliveryAddress}
          onChange={(e) => updateField('deliveryAddress', e.target.value)}
        />
        <div id={`${deliveryAddressId}-hint`} className={styles.hint}>买家咨询"哪里发货"时，AI 会自动回复此地址</div>
        {errors.deliveryAddress && <div id={`${deliveryAddressId}-error`} className={styles.error} role="alert">{errors.deliveryAddress}</div>}
      </div>

      {/* 发货时长 */}
      <div className={styles.formGroup}>
        <label htmlFor={deliveryTimeId}>
          <Clock size={14} />
          发货时长
        </label>
        <Input
          id={deliveryTimeId}
          type="text"
          aria-describedby={`${deliveryTimeId}-hint${errors.deliveryTime ? ` ${deliveryTimeId}-error` : ''}`}
          aria-invalid={Boolean(errors.deliveryTime)}
          placeholder="如：24小时内、48小时内、3天内"
          value={config.deliveryTime}
          onChange={(e) => updateField('deliveryTime', e.target.value)}
        />
        <div id={`${deliveryTimeId}-hint`} className={styles.hint}>买家咨询"什么时候发货"时，AI 会自动回复此时长</div>
        {errors.deliveryTime && <div id={`${deliveryTimeId}-error`} className={styles.error} role="alert">{errors.deliveryTime}</div>}
      </div>

      {/* 运费险 */}
      <div className={styles.formGroup}>
        <div className={styles.switchRow}>
          <div className={styles.switchCopy}>
            <div className={styles.switchLabel}>
              <Shield size={14} aria-hidden="true" />
              运费险
            </div>
            <div id="freight-insurance-hint" className={`${styles.hint} ${styles.switchHint}`}>
              是否提供退换货运费险服务
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.freightInsurance}
            aria-label="运费险"
            aria-describedby="freight-insurance-hint"
            className={[styles.switch, config.freightInsurance ? styles.on : ''].filter(Boolean).join(' ')}
            onClick={() => updateField('freightInsurance', !config.freightInsurance)}
          />
        </div>
      </div>

      {/* 包邮政策 */}
      <div className={styles.formGroup}>
        <div className={styles.switchRow}>
          <div className={styles.switchCopy}>
            <div className={styles.switchLabel}>
              <Gift size={14} aria-hidden="true" />
              包邮服务
            </div>
            <div id="free-shipping-hint" className={`${styles.hint} ${styles.switchHint}`}>
              是否提供包邮服务
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config.freeShipping}
            aria-label="包邮服务"
            aria-describedby="free-shipping-hint"
            className={[styles.switch, config.freeShipping ? styles.on : ''].filter(Boolean).join(' ')}
            onClick={() => updateField('freeShipping', !config.freeShipping)}
          />
        </div>
        {config.freeShipping && (
          <div className={styles.conditionRow}>
            <label className={styles.fieldLabel} htmlFor={freeShippingConditionId}>包邮条件</label>
            <Input
              id={freeShippingConditionId}
              type="text"
              aria-describedby={`${freeShippingConditionId}-hint${errors.freeShippingCondition ? ` ${freeShippingConditionId}-error` : ''}`}
              aria-invalid={Boolean(errors.freeShippingCondition)}
              placeholder="如：全场包邮 / 满59元包邮"
              value={config.freeShippingCondition}
              onChange={(e) => updateField('freeShippingCondition', e.target.value)}
            />
            <div id={`${freeShippingConditionId}-hint`} className={styles.hint}>描述包邮的具体条件，留空表示全场包邮</div>
            {errors.freeShippingCondition && <div id={`${freeShippingConditionId}-error`} className={styles.error} role="alert">{errors.freeShippingCondition}</div>}
          </div>
        )}
      </div>

      {/* 合作快递公司 */}
      <div className={styles.formGroup}>
        <label>
          <Truck size={14} />
          合作快递公司
        </label>
        <div className={styles.hint}>勾选主要合作的快递公司，买家咨询"发什么快递"时 AI 会回复</div>
        <div className={styles.checkboxGrid}>
          {EXPRESS_OPTIONS.map((company) => (
            <label key={company} className={styles.checkboxItem}>
              <input
                type="checkbox"
                checked={config.expressCompanies?.includes(company) ?? false}
                onChange={() => toggleExpress(company)}
              />
              {company}
            </label>
          ))}
        </div>
      </div>

      {/* 客服专员映射（智能转接） */}
      <div className={styles.formGroup}>
        <label>
          <Headphones size={14} />
          客服专员映射（智能转接）
        </label>
        <div className={styles.hint}>
          配置每个专员角色对应的飞鸽客服账号名。AI 调用转人工时会自动在飞鸽页面执行转接操作；留空则该角色不启用自动转接（降级为通用人工接管）。
        </div>
        <div className={styles.agentMappingTable}>
          {AGENT_MAPPING_ROWS.map((row) => {
            const value = config.agentMappings?.[row.role] ?? '';
            const inputId = `${fieldIdPrefix}-agent-${row.role}`;
            const hintId = `${inputId}-hint`;
            return (
              <div key={row.role} className={styles.agentMappingRow}>
                <div className={styles.agentRoleCell}>
                  <label className={styles.agentRoleName} htmlFor={inputId}>{row.name}</label>
                  <span id={hintId} className={styles.agentRoleScene}>{row.scene}</span>
                </div>
                <div className={styles.agentInputCell}>
                  <Input
                    id={inputId}
                    type="text"
                    aria-describedby={hintId}
                    placeholder="输入飞鸽客服账号名（留空则不启用）"
                    value={value}
                    onChange={(e) => updateAgentMapping(row.role, e.target.value)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 店铺人设（拟人化语气） */}
      <div className={styles.formGroup}>
        <label>
          <Sparkles size={14} />
          店铺人设（拟人化语气）
        </label>
        <div className={styles.hint}>
          配置 AI 回复的语气风格、昵称、口头禅等，让 AI 像真人客服一样与买家沟通。这些设置会注入到 AI 的系统提示词中。
        </div>

        {/* 语气风格 */}
        <div className={styles.personaSection}>
          <div className={styles.personaFieldLabel}>语气风格</div>
          <div className={styles.toneGrid} role="radiogroup" aria-label="客服语气风格">
            {TONE_OPTIONS.map((opt) => {
              const isActive = (config.persona ?? DEFAULT_PERSONA).tone === opt.value;
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  key={opt.value}
                  className={[styles.toneCard, isActive ? styles.toneCardActive : ''].filter(Boolean).join(' ')}
                  onClick={() => updatePersonaField('tone', opt.value)}
                >
                  <span className={styles.toneCardName}>{opt.label}</span>
                  <span className={styles.toneCardDesc}>{opt.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 客服昵称 */}
        <div className={styles.personaField}>
          <label className={styles.personaFieldLabel} htmlFor="shop-persona-nickname">
            客服昵称（买家问"你叫什么"时回答，留空则不设置）
          </label>
          <Input
            id="shop-persona-nickname"
            type="text"
            placeholder="如：小柚子、糖糖、阿杰"
            value={(config.persona ?? DEFAULT_PERSONA).nickname}
            onChange={(e) => updatePersonaField('nickname', e.target.value)}
          />
          <div className={styles.charCount}>{(config.persona ?? DEFAULT_PERSONA).nickname.length}/20</div>
        </div>

        {/* 口头禅 */}
        <div className={styles.personaField}>
          <label className={styles.personaFieldLabel} htmlFor="shop-persona-catchphrases">
            口头禅（用逗号或换行分隔，最多 5 个，回复末尾偶尔使用）
          </label>
          <Input
            id="shop-persona-catchphrases"
            type="text"
            placeholder="如：~哦, 哒哒, 亲亲"
            defaultValue={(config.persona ?? DEFAULT_PERSONA).catchphrases.join(', ')}
            onChange={(e) => updateCatchphrases(e.target.value)}
          />
          {(config.persona ?? DEFAULT_PERSONA).catchphrases.length > 0 && (
            <div className={styles.catchphraseTags}>
              {(config.persona ?? DEFAULT_PERSONA).catchphrases.map((tag, idx) => (
                <span key={`${tag}-${idx}`} className={styles.catchphraseTag}>
                  {tag}
                  <button
                    type="button"
                    aria-label={`删除口头禅 ${tag}`}
                    className={styles.catchphraseRemove}
                    onClick={() => {
                      const newList = (config.persona ?? DEFAULT_PERSONA).catchphrases.filter((_, i) => i !== idx);
                      updatePersonaField('catchphrases', newList);
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 表情符号开关 */}
        <div className={styles.personaField}>
          <div className={styles.switchRow}>
            <div className={styles.switchCopy}>
              <div className={styles.switchLabel}>使用表情符号</div>
              <div id="persona-emoji-hint" className={`${styles.hint} ${styles.switchHint}`}>
                开启后 AI 可在回复中适度使用表情（如 😊、💕）
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={(config.persona ?? DEFAULT_PERSONA).useEmojis}
              aria-label="使用表情符号"
              aria-describedby="persona-emoji-hint"
              className={[styles.switch, (config.persona ?? DEFAULT_PERSONA).useEmojis ? styles.on : ''].filter(Boolean).join(' ')}
              onClick={() => updatePersonaField('useEmojis', !(config.persona ?? DEFAULT_PERSONA).useEmojis)}
            />
          </div>
        </div>

        {/* 自定义人设描述 */}
        <div className={styles.personaField}>
          <label className={styles.personaFieldLabel} htmlFor="shop-persona-description">
            自定义人设描述（描述客服人设特征，作为回复风格总指引）
          </label>
          <textarea
            id="shop-persona-description"
            className={styles.personaTextarea}
            placeholder="如：你是一位 25 岁的温柔女孩客服，喜欢用叠词，耐心细致，遇到售后问题会主动安抚买家情绪..."
            value={(config.persona ?? DEFAULT_PERSONA).description}
            onChange={(e) => updatePersonaField('description', e.target.value)}
          />
          <div className={styles.charCount}>{(config.persona ?? DEFAULT_PERSONA).description.length}/200</div>
        </div>
      </div>

      {/* 保存状态 */}
      <div
        className={[styles.saveStatus, styles[saveStatus]].filter(Boolean).join(' ')}
        role="status"
        aria-live="polite"
      >
        {saveStatus === 'saving' && <><Loader2 size={12} className="spin" /> 保存中...</>}
        {saveStatus === 'saved' && <><Check size={12} /> 已保存</>}
        {saveStatus === 'error' && '保存失败'}
        {saveStatus === 'idle' && '\u00A0'}
      </div>
    </div>
  );
}
