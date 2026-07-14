/**
 * 大师数据服务
 * 负责加载和管理AI占卜大师的配置数据
 */

import type { Master } from '../types';
import type { MasterConfig, ExtendedMaster, GamePromptConfig } from './types';
import axios from 'axios';
import { useAppStore } from '../core/store';
import { 
  GEMINI_CONFIG, 
  buildGeminiApiUrl, 
  buildModelsListUrl, 
  isValidApiKeyFormat,
  isSupportedImageType,
  isValidFileSize,
  getActiveApiKey,
  hasValidApiKey
} from './config';
import { getGamePrompt, isGameTypeSupported } from './prompts';
import { getProvider as getProviderCfg, buildDirectChatUrl, type LLMProviderConfig } from './providers';

// 🚀 流式响应控制开关 - 在这里修改即可控制全局行为
const ENABLE_STREAMING = false; // true: 使用SSE流式API, false: 使用标准API+前端模拟流式效果


/**
 * 从public目录加载大师配置数据
 * @returns Promise<Master[]> 大师列表
 * @throws 当配置文件加载失败或格式错误时抛出异常
 */
export async function fetchMasters(): Promise<Master[]> {
  try {
    // 优化环境检测逻辑，减少性能开销
    const isElectronEnv = typeof window !== 'undefined' && window.electronAPI;
    
    const configUrl = isElectronEnv ? './masters/config.json' : '/masters/config.json';
    const response = await fetch(configUrl);
    
    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status} ${response.statusText}`);
    }
    
    const config: MasterConfig = await response.json();
    
    // 验证配置文件格式
    if (!config || !Array.isArray(config.masters)) {
      throw new Error('配置文件格式错误：缺少masters数组');
    }
    
    // 验证每个大师的必需字段
    for (const master of config.masters) {
      if (!master.id || !master.name || !master.description || !master.prompt) {
        throw new Error(`大师配置不完整：${master.id || '未知ID'}`);
      }
    }
    
    console.log(`成功加载 ${config.masters.length} 个大师配置`);
    return config.masters;
    
  } catch (error) {
    console.error('加载大师配置失败:', error);
    
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new Error('网络错误：无法加载大师配置文件');
    }
    
    throw error;
  }
}

/**
 * 根据ID查找特定大师
 * @param masters 大师列表
 * @param id 大师ID
 * @returns Master | undefined
 */
export function findMasterById(masters: Master[], id: string): Master | undefined {
  return masters.find(master => master.id === id);
}

/**
 * 获取默认大师（优先选择周文王，否则第一个大师）
 * @param masters 大师列表
 * @returns Master | null
 */
export function getDefaultMaster(masters: Master[]): Master | null {
  if (masters.length === 0) return null;
  
  // 优先选择周文王
  const zhouwenwang = masters.find(master => master.id === 'zhouwenwang');
  if (zhouwenwang) return zhouwenwang;
  
  // 否则返回第一个大师
  return masters[0];
}

/**
 * 验证大师对象是否有效
 * @param master 大师对象
 * @returns boolean
 */
export function isValidMaster(master: any): master is Master {
  return (
    master &&
    typeof master === 'object' &&
    typeof master.id === 'string' &&
    typeof master.name === 'string' &&
    typeof master.description === 'string' &&
    typeof master.prompt === 'string' &&
    master.id.length > 0 &&
    master.name.length > 0 &&
    master.description.length > 0 &&
    master.prompt.length > 0
  );
}

/**
 * Gemini API响应接口
 */
interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
  }>;
}

/**
 * Gemini API错误响应接口
 */
interface GeminiErrorResponse {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * 构建AI分析提示词
 * @param master 选中的大师
 * @param divinationData 占卜数据
 * @param gameType 游戏类型（如：liuyao, qimen, palmistry）
 * @param userInfo 用户信息（可选）
 * @returns 完整的提示词
 */
function buildPrompt(master: Master, divinationData: any, gameType?: string, userInfo?: any): string {
  // 🔍 调试日志：确认函数被调用
  console.warn('🚨 [DEBUG] buildPrompt 函数被调用 - 游戏类型:', gameType, '大师:', master.name);
  
  let prompt = master.prompt;
  
  // 根据游戏类型添加特定的提示词
  if (gameType) {
    const gamePrompt = getGameSpecificPrompt(master, gameType, userInfo);
    if (gamePrompt) {
      prompt += '\n\n' + gamePrompt;
    }
  }
  
  // 添加占卜数据
  prompt += '\n\n占卜数据：\n';
  if (typeof divinationData === 'object') {
    prompt += JSON.stringify(divinationData, null, 2);
  } else {
    prompt += String(divinationData);
  }
  
  // 添加用户信息（如果有）
  if (userInfo) {
    prompt += '\n\n用户信息：\n';
    if (typeof userInfo === 'object') {
      prompt += JSON.stringify(userInfo, null, 2);
    } else {
      prompt += String(userInfo);
    }
  }
  
  prompt += '\n\n请根据以上信息进行详细的占卜分析：';
  
  // 加强明确的中文要求 - 适用于所有游戏类型
  prompt += '\n\n**严格语言要求**：\n- 回复内容必须100%使用简体中文\n- 严禁使用英文、俄文、日文或任何其他语言\n- 所有术语、解释、建议、标点符号都必须是中文\n- 如遇到专业术语，必须使用中文表达或中文音译';
  
  // 添加通用Markdown格式要求（仅在没有特定游戏类型时添加）
  if (!gameType) {
    prompt += '\n\n**格式要求**：\n- 必须使用Markdown格式输出\n- 使用合适的标题层级（##、###、####）\n- 仅在关键结论和核心要点处谨慎使用**粗体**标记，避免过度使用\n- 使用项目符号和编号列表组织内容\n- 语言要体现你的风格特色，分析要深入透彻，建议要实用可行';
  }
  
  return prompt;
}

/**
 * 根据配置构建游戏专用提示词
 * @param config 游戏提示词配置
 * @param gameType 游戏类型
 * @returns 构建好的提示词
 */
function buildGamePromptFromConfig(config: GamePromptConfig, gameType: string): string {
  let prompt = config.baseRole;
  prompt += `\n\n${config.analysisStyle}`;
  return prompt;
}

/**
 * 根据游戏类型获取特定的提示词
 * @param master 大师对象
 * @param gameType 游戏类型
 * @param userInfo 用户信息，用于判断是否有问事
 * @returns 游戏特定的提示词，如果没有则返回null
 */
function getGameSpecificPrompt(master: Master, gameType: string, userInfo?: any): string | null {
  const extendedMaster = master as ExtendedMaster;
  
  // 检查是否支持该游戏类型
  if (!isGameTypeSupported(gameType)) {
    return null;
  }
  
  // 检查是否有问事内容（仅对八字有效）
  const hasSpecialContext = gameType === 'bazi' && 
    userInfo && typeof userInfo === 'object' && 
    userInfo.question && typeof userInfo.question === 'string' && 
    userInfo.question.trim().length > 0;
  
  // 获取基础的业务提示词
  let basePrompt = getGamePrompt(gameType, master, hasSpecialContext);
  
  if (!basePrompt) {
    return null;
  }
  
  // 如果大师配置了游戏专用的个性化提示词，则与业务模板结合
  if (extendedMaster.gamePrompts && extendedMaster.gamePrompts[gameType]) {
    const personalizedPrompt = buildGamePromptFromConfig(extendedMaster.gamePrompts[gameType], gameType);
    // 将个性化信息插入到基础提示词之前
    basePrompt = basePrompt.replace(
      `你是${master.name}`,
      personalizedPrompt + '\n\n你是' + master.name
    );
  }
  
  return basePrompt;
}





/**
 * 检查后端服务器健康状态
 * @param serverUrl 服务器URL
 * @returns Promise<boolean> 服务器是否可用
 */
async function checkServerHealth(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000) // 5秒超时
    });
    
    if (!response.ok) {
      return false;
    }
    
    const data = await response.json();
    return data.status === 'ok';
  } catch (error) {
    console.warn('服务器健康检查失败:', error);
    return false;
  }
}

/**
 * 通过后端服务器进行标准分析（非流式）
 * @param serverUrl 服务器URL
 * @param prompt 分析提示词
 * @returns Promise<string> 完整的分析结果
 */
async function getServerStandardAnalysis(
  serverUrl: string,
  prompt: string
): Promise<string> {
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/gemini/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ 
        role: 'user', 
        parts: [{ text: prompt }] 
      }],
      generationConfig: {
        temperature: 0.7,
        topK: 32,
        topP: 1,
        maxOutputTokens: 4096,
      }
    })
  });

  if (!response.ok) {
    throw new Error(`服务器标准API调用失败: HTTP ${response.status}`);
  }

  const data = await response.json();
  
  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('服务器未返回有效数据');
  }
  
  const candidate = data.candidates[0];
  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new Error('服务器返回数据格式错误');
  }
  
  const analysisText = candidate.content.parts[0].text;
  
  if (!analysisText || analysisText.trim() === '') {
    throw new Error('服务器返回的分析结果为空');
  }
  
  return analysisText.trim();
}

/**
 * 统一的服务器分析函数，根据设置选择流式或非流式
 * @param serverUrl 服务器URL
 * @param prompt 分析提示词
 * @param enableStreaming 是否启用流式响应
 * @param onUpdate 流式更新回调函数（仅流式模式使用）
 * @returns Promise<string> 完整的分析结果
 */
async function getServerAnalysis(
  serverUrl: string,
  prompt: string,
  enableStreaming: boolean,
  onUpdate?: (text: string) => void
): Promise<string> {
  if (enableStreaming) {
    // 使用流式API
    return await getServerStreamAnalysis(serverUrl, prompt, onUpdate);
  } else {
    // 使用标准API
    const result = await getServerStandardAnalysis(serverUrl, prompt);
    
    // 如果有更新回调，模拟流式显示效果
    if (onUpdate && result) {
      const words = result.split('');
      const chunkSize = 3; // 每次显示3个字符
      const delay = 30; // 30ms延迟，模拟打字效果
      
      let currentText = '';
      
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join('');
        currentText += chunk;
        onUpdate(currentText);
        
        // 添加延迟以模拟流式效果
        if (i + chunkSize < words.length) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      // 确保最终显示完整文本
      onUpdate(result);
    }
    
    return result;
  }
}

/**
 * 通过后端服务器进行流式分析
 * @param serverUrl 服务器URL
 * @param prompt 分析提示词
 * @param onUpdate 流式更新回调函数
 * @returns Promise<string> 完整的分析结果
 */
async function getServerStreamAnalysis(
  serverUrl: string,
  prompt: string,
  onUpdate?: (text: string) => void
): Promise<string> {
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/gemini/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: prompt,
      maxTokens: 4096
    })
  });

  if (!response.ok) {
    throw new Error(`服务器流式API调用失败: HTTP ${response.status}`);
  }

  // 设置响应编码为UTF-8，避免乱码
  if (!response.body) {
    throw new Error('无法获取响应流');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let accumulatedText = '';
  let lastSentLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      const chunkStr = decoder.decode(value, { stream: true });
      const lines = chunkStr.split('\n');
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        
        // 解析SSE格式的数据
        if (trimmedLine.startsWith('data: ')) {
          const jsonStr = trimmedLine.slice(6); // 移除 'data: ' 前缀
          
          if (jsonStr === '[DONE]') {
            break;
          }
          
          try {
            const data = JSON.parse(jsonStr);
            
            // 检查是否是完成信号
            if (data.done === true) {
              console.log('后端流式响应完成');
              break;
            }
            
            // 检查是否有错误
            if (data.error) {
              throw new Error(`后端服务器错误: ${data.error}`);
            }
            
            // 处理增量内容
            if (data.content && typeof data.content === 'string') {
              accumulatedText += data.content; // 累积增量内容
              
              if (onUpdate) {
                onUpdate(accumulatedText);
              }
              
              // 移除冗余日志：后端流式数据接收
            }
            
          } catch (parseError) {
            // 忽略JSON解析错误，继续处理下一行
            console.warn('JSON解析失败:', parseError);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  if (!accumulatedText || accumulatedText.trim() === '') {
    throw new Error('后端服务器未返回有效数据');
  }
  
  return accumulatedText.trim();
}

// ---------------------------------------------------------------------------
// Multi-provider support (added in feature/minimax-provider)
// ---------------------------------------------------------------------------
// These functions mirror the legacy /api/gemini/* helpers above but route
// through /api/llm/*, which the backend (backend/routes/llm.js) dispatches
// to the right upstream based on the `provider` field. They always return
// Gemini-shaped responses so the rest of the file keeps working unchanged.
// ---------------------------------------------------------------------------

/**
 * Standard (non-streaming) provider-routed call. The response is parsed
 * as Gemini-shaped: { candidates: [{ content: { parts: [{ text }] } }] }.
 */
async function getServerRoutedStandardAnalysis(
  serverUrl: string,
  prompt: string,
  providerId: string,
  apiKey: string,
  model: string
): Promise<string> {
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/llm/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider: providerId,
      apiKey: apiKey || undefined,
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 1,
        maxOutputTokens: 4096,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    let errMsg = `服务器API调用失败: HTTP ${response.status}`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson && errJson.error) errMsg = `服务器API调用失败: ${errJson.error}`;
    } catch {
      if (errText) errMsg = `服务器API调用失败: ${response.status} ${errText.slice(0, 200)}`;
    }
    throw new Error(errMsg);
  }

  const data = await response.json();
  if (data && typeof data.text === 'string' && data.text.trim()) {
    return data.text.trim();
  }
  // Back-compat: parse Gemini-shaped envelope
  if (data && data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
    return data.candidates[0].content.parts[0].text.trim();
  }
  throw new Error('服务器未返回有效数据');
}

/**
 * Stream-routed provider call. Emits a stream of `data: {content, done}` events.
 */
async function getServerRoutedStreamAnalysis(
  serverUrl: string,
  prompt: string,
  providerId: string,
  apiKey: string,
  model: string,
  onUpdate?: (text: string) => void
): Promise<string> {
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/llm/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider: providerId,
      apiKey: apiKey || undefined,
      model,
      prompt,
      maxTokens: 4096,
    }),
  });

  if (!response.ok) {
    throw new Error(`服务器流式API调用失败: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('无法获取响应流');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let accumulatedText = '';
  let lastSentLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunkStr = decoder.decode(value, { stream: true });
      const lines = chunkStr.split('\n');
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('data: ')) continue;
        const jsonStr = trimmedLine.slice(6);
        if (jsonStr === '[DONE]') continue;
        try {
          const data = JSON.parse(jsonStr);
          if (data.done === true) continue;
          if (data.error) throw new Error(`后端服务器错误: ${data.error}`);
          if (typeof data.content === 'string' && data.content.length > 0) {
            // SSE emits full text in a single delta; if the backend ever
            // moves to true token-level deltas, this will Just Work.
            accumulatedText = data.content;
            if (onUpdate && accumulatedText.length !== lastSentLength) {
              onUpdate(accumulatedText);
              lastSentLength = accumulatedText.length;
            }
          }
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message.startsWith('后端服务器错误')) {
            throw parseError;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return accumulatedText.trim();
}

/**
 * Direct (browser-side) call to a provider's chat API. Used when the user
 * has no backend server configured. ONLY safe for providers whose
 * `directBaseUrl` allows browser CORS — MiniMax does NOT (no permissive
 * CORS), so this path is intentionally not used for MiniMax in production.
 * We keep it for the case where the user runs the backend's CORS proxy
 * (or for providers like Gemini which do allow CORS).
 */
async function getDirectProviderAnalysis(
  provider: LLMProviderConfig,
  apiKey: string,
  prompt: string,
  model: string,
  onUpdate?: (text: string) => void
): Promise<string> {
  const url = buildDirectChatUrl(provider, model);
  const body = provider.buildDirectRequest({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, topP: 1, maxOutputTokens: 4096 },
    model,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...provider.directAuthHeader(apiKey),
    },
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`直连 ${provider.displayName} 失败: HTTP ${response.status} ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  const text = provider.extractDirectText(data) || '';
  if (!text) throw new Error(`${provider.displayName} 返回数据为空`);
  if (onUpdate) onUpdate(text);
  return text.trim();
}

/**
 * Pick the user's effective API key for the active provider. Falls back to
 * the legacy `apiKey` field if `providerApiKey` is empty (back-compat).
 */
function resolveEffectiveApiKey(state: { settings: { provider?: string; apiKey: string; providerApiKey?: string } }): string {
  const s = state.settings;
  const providerId = s.provider || 'gemini';
  if (providerId === 'gemini') return (s.providerApiKey || s.apiKey || '').trim();
  return (s.providerApiKey || '').trim();
}

/**
 * Resolve the active provider and model from settings. Falls back to
 * gemini + the gemini default model when nothing is set.
 */
function resolveActiveProvider(): { provider: LLMProviderConfig; apiKey: string; model: string } {
  const state = useAppStore.getState();
  const provider = getProviderCfg(state.settings.provider);
  const apiKey = resolveEffectiveApiKey(state);
  const model = (state.settings.providerModel || '').trim() || provider.defaultModel;
  return { provider, apiKey, model };
}

/**
 * Pick the right server analysis function. The new routed paths handle
 * any provider; we always use them when a serverUrl is configured. We
 * fall back to the legacy /api/gemini/* path only for the gemini default
 * to preserve the existing SSE-parsing behavior of the original code.
 */
async function callServerAnalysis(
  serverUrl: string,
  prompt: string,
  enableStreaming: boolean,
  onUpdate?: (text: string) => void
): Promise<string> {
  const { provider, apiKey, model } = resolveActiveProvider();
  if (enableStreaming) {
    return await getServerRoutedStreamAnalysis(serverUrl, prompt, provider.id, apiKey, model, onUpdate);
  }
  return await getServerRoutedStandardAnalysis(serverUrl, prompt, provider.id, apiKey, model);
}

/**
 * 获取AI流式分析结果（支持后端服务器和降级处理）
 * @param divinationData 占卜数据
 * @param master 选中的大师
 * @param gameType 游戏类型（如：liuyao, qimen, palmistry）
 * @param userInfo 用户信息（可选）
 * @param onUpdate 流式更新回调函数
 * @returns Promise<string> 完整的AI分析结果
 * @throws 当API调用失败或配置错误时抛出异常
 */
export async function getAIAnalysisStream(
  divinationData: any,
  master: Master,
  gameType?: string,
  userInfo?: any,
  onUpdate?: (text: string) => void
): Promise<string> {
  try {
    // 1. 获取设置
    const state = useAppStore.getState();
    const { apiKey, serverUrl } = state.settings;
    const enableStreaming = ENABLE_STREAMING; // 使用代码中的开关
    
    // 2. 验证大师对象
    if (!isValidMaster(master)) {
      throw new Error('大师配置无效');
    }
    
    // 3. 构建提示词
    const prompt = buildPrompt(master, divinationData, gameType, userInfo);
    console.log('构建的提示词:', prompt);
    
    // 4. 如果配置了服务器URL，优先使用后端服务器
    if (serverUrl && serverUrl.trim()) {

      try {
        // 检查服务器健康状态
        const isServerHealthy = await checkServerHealth(serverUrl);

        if (isServerHealthy) {
          console.log(`使用${enableStreaming ? '流式' : '标准'}后端服务器API...`);
          return await callServerAnalysis(serverUrl, prompt, enableStreaming, onUpdate);
        } else {
          console.warn('后端服务器健康检查失败，降级到直接API调用');
        }
      } catch (serverError) {
        console.warn('后端服务器调用失败，降级到直接API调用:', serverError);
      }
    }

    // 5. 降级到直接API调用 — 路由根据当前 provider 选择
    const { provider: activeProvider, apiKey: activeApiKey, model: activeModel } = resolveActiveProvider();
    console.log(`使用直接${activeProvider.displayName} API调用...`);

    // 验证API密钥
    if (!activeApiKey || !activeProvider.isValidApiKeyFormat(activeApiKey)) {
      if (serverUrl && serverUrl.trim()) {
        throw new Error(`后端服务器不可用，且未配置有效的 ${activeProvider.displayName} API 密钥。请检查服务器状态或配置 API 密钥。`);
      } else {
        throw new Error(`请先在设置中配置有效的 ${activeProvider.displayName} API 密钥`);
      }
    }

    try {
      // 直连流式 / 标准 调用。MiniMax 不支持浏览器直连 (CORS),需要后端代理;
      // 这里如果直连失败,getDirectProviderAnalysis 会抛出,外层会再次尝试 Gemini
      // 风格的标准调用兜底。
      const directText = await getDirectProviderAnalysis(activeProvider, activeApiKey, prompt, activeModel);
      if (onUpdate) onUpdate(directText);
      return directText;
    } catch (directError) {
      console.warn(`直连${activeProvider.displayName} 失败,降级到标准API:`, directError);

      // 6. 最终降级到标准API(非流式),由前端模拟流式效果
      const result = await getAIAnalysis(divinationData, master, gameType, userInfo);

      if (onUpdate && result) {
        const words = result.split('');
        let currentText = '';

        for (let i = 0; i < words.length; i++) {
          currentText += words[i];
          onUpdate(currentText);

          // 控制速度,每几个字符暂停一下
          if (i % 3 === 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
          }
        }
      }

      return result;
    }

  } catch (error) {
    console.error('AI分析失败:', error);
    
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error('未知错误发生');
    }
  }
}

/**
 * 获取AI分析结果（非流式，保持向后兼容）
 * @param divinationData 占卜数据
 * @param master 选中的大师
 * @param gameType 游戏类型（如：liuyao, qimen, palmistry）
 * @param userInfo 用户信息（可选）
 * @returns Promise<string> AI分析结果
 * @throws 当API调用失败或配置错误时抛出异常
 */
export async function getAIAnalysis(
  divinationData: any,
  master: Master,
  gameType?: string,
  userInfo?: any
): Promise<string> {
  try {
    // 1. 获取设置
    const state = useAppStore.getState();
    const { apiKey, serverUrl } = state.settings;
    // 对于非流式分析，始终使用标准API
    const enableStreaming = false;
    
    // 2. 如果配置了服务器URL，优先使用后端服务器
    if (serverUrl && serverUrl.trim()) {

      try {
        // 检查服务器健康状态
        const isServerHealthy = await checkServerHealth(serverUrl);

        if (isServerHealthy) {
          console.log('后端服务器健康检查通过，使用服务器API...');
          // 构建提示词
          const prompt = buildPrompt(master, divinationData, gameType, userInfo);
          // 对于非流式分析，强制使用标准API，路由由 callServerAnalysis 决定
          return await callServerAnalysis(serverUrl, prompt, false);
        } else {
          console.warn('后端服务器健康检查失败，降级到直接API调用');
        }
      } catch (serverError) {
        console.warn('后端服务器调用失败，降级到直接API调用:', serverError);
      }
    }

    // 3. 验证API密钥（只有在没有可用服务器时才强制要求）
    const { provider: activeProvider, apiKey: activeApiKey, model: activeModel } = resolveActiveProvider();
    if (!activeApiKey || !activeProvider.isValidApiKeyFormat(activeApiKey)) {
      if (serverUrl && serverUrl.trim()) {
        throw new Error(`后端服务器不可用，且未配置有效的 ${activeProvider.displayName} API 密钥。请检查服务器状态或配置 API 密钥。`);
      } else {
        throw new Error(`请先在设置中配置有效的 ${activeProvider.displayName} API 密钥`);
      }
    }

    // 4. 验证大师对象
    if (!isValidMaster(master)) {
      throw new Error('大师配置无效');
    }

    // 5. 构建提示词
    const prompt = buildPrompt(master, divinationData, gameType, userInfo);
    console.log('构建的提示词:', prompt);

    // 6. 直连 provider（MiniMax 在浏览器无 CORS 时会失败,由调用方处理降级）
    console.log(`正在调用 ${activeProvider.displayName} API...`);
    return await getDirectProviderAnalysis(activeProvider, activeApiKey, prompt, activeModel);
  } catch (error) {
    console.error('AI分析失败:', error);
    
    // 处理不同类型的错误
    if (axios.isAxiosError(error)) {
      // 处理HTTP错误
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data as GeminiErrorResponse;
        
        switch (status) {
          case 400:
            throw new Error(`API请求错误: ${errorData.error?.message || '请求参数有误'}`);
          case 401:
            throw new Error('API密钥无效，请检查设置中的Gemini API密钥');
          case 403:
            throw new Error('API访问被拒绝，请检查API密钥权限');
          case 429:
            throw new Error('API调用频率超限，请稍后再试');
          case 500:
            throw new Error('Gemini服务器内部错误，请稍后再试');
          default:
            throw new Error(`API调用失败 (HTTP ${status}): ${errorData.error?.message || '未知错误'}`);
        }
      } else if (error.request) {
        throw new Error('网络连接失败，请检查网络连接后重试');
      }
    }
    
    // 处理超时错误
    if (error instanceof Error && 'code' in error && error.code === 'ECONNABORTED') {
      throw new Error('API调用超时，请检查网络连接后重试');
    }
    
    // 重新抛出其他错误
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error('未知错误发生');
    }
  }
}

/**
 * Gemini Vision API响应接口
 */
interface GeminiVisionResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
  }>;
}

/**
 * 获取手相分析结果（使用Gemini Vision API）
 * @param imageBase64 图像的base64编码数据（不含data:image/...前缀）
 * @param mimeType 图像MIME类型（如 'image/jpeg'）
 * @param master 选中的大师
 * @param userInfo 用户信息（可选）
 * @returns Promise<string> AI分析结果
 * @throws 当API调用失败或配置错误时抛出异常
 */
export async function getPalmistryAnalysis(
  imageBase64: string,
  mimeType: string,
  master: Master,
  userInfo?: any
): Promise<string> {
  try {
    // 1. 获取API密钥（优先使用配置中的密钥）
    const state = useAppStore.getState();
    const apiKey = getActiveApiKey(state.settings.apiKey);
    
    if (!hasValidApiKey(state.settings.apiKey)) {
      throw new Error('请先在配置文件或设置中配置有效的Gemini API密钥');
    }
    
    // 2. 验证大师对象
    if (!isValidMaster(master)) {
      throw new Error('大师配置无效');
    }
    
    // 3. 验证图像数据
    if (!imageBase64 || imageBase64.trim() === '') {
      throw new Error('图像数据不能为空');
    }
    
    if (!mimeType || !isSupportedImageType(mimeType)) {
      throw new Error(`无效的图像格式，请使用 ${GEMINI_CONFIG.FILE_CONFIG.SUPPORTED_IMAGE_TYPES.join(', ')} 格式`);
    }
    
    // 4. 构建提示词 - 使用统一的提示词构建系统
    const prompt = buildPrompt(master, {
      message: "请分析这张手相图片", 
      imageType: "palmistry"
    }, 'palmistry', userInfo);
    console.log('构建的手相分析提示词:', prompt);
    
    // 5. 构建API请求（使用Gemini 2.0 Flash）
    const apiUrl = buildGeminiApiUrl(GEMINI_CONFIG.MODELS.VISION, apiKey);
    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: prompt
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: imageBase64
              }
            }
          ]
        }
      ],
      generationConfig: GEMINI_CONFIG.GENERATION_CONFIG
    };
    
    console.log('正在调用Gemini Vision API进行手相分析...');
    
    // 6. 调用Gemini Vision API
    const response = await axios.post<GeminiVisionResponse>(apiUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: GEMINI_CONFIG.REQUEST_CONFIG.VISION_TIMEOUT
    });
    
    // 7. 解析响应
    const data = response.data;
    
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error('API返回数据格式错误：没有候选结果');
    }
    
    const candidate = data.candidates[0];
    if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
      throw new Error('API返回数据格式错误：没有内容部分');
    }
    
    const analysisText = candidate.content.parts[0].text;
    
    if (!analysisText || analysisText.trim() === '') {
      throw new Error('API返回的分析结果为空');
    }
    
    console.log('手相分析成功完成');
    return analysisText.trim();
    
  } catch (error) {
    console.error('手相分析失败:', error);
    
    // 处理不同类型的错误
    if (axios.isAxiosError(error)) {
      // 处理HTTP错误
      if (error.response) {
        const status = error.response.status;
        const errorData = error.response.data as GeminiErrorResponse;
        
        switch (status) {
          case 400:
            throw new Error(`API请求错误: ${errorData.error?.message || '请求参数有误，请检查图片格式和大小'}`);
          case 401:
            throw new Error('API密钥无效，请检查设置中的Gemini API密钥');
          case 403:
            throw new Error('API访问被拒绝，请检查API密钥权限或是否启用了Vision API');
          case 413:
            throw new Error('图片文件过大，请选择较小的图片文件');
          case 429:
            throw new Error('API调用频率超限，请稍后再试');
          case 500:
            throw new Error('Gemini服务器内部错误，请稍后再试');
          default:
            throw new Error(`API调用失败 (HTTP ${status}): ${errorData.error?.message || '未知错误'}`);
        }
      } else if (error.request) {
        throw new Error('网络连接失败，请检查网络连接后重试');
      }
    }
    
    // 处理超时错误
    if (error instanceof Error && 'code' in error && error.code === 'ECONNABORTED') {
      throw new Error('图像分析超时，请稍后重试或选择较小的图片');
    }
    
    // 重新抛出其他错误
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error('未知错误发生');
    }
  }
}

/**
 * 通过后端服务器进行流式手相分析
 * @param serverUrl 服务器URL
 * @param imageBase64 Base64编码的图像数据
 * @param mimeType 图像MIME类型
 * @param prompt 分析提示词
 * @param onUpdate 流式更新回调函数
 * @returns Promise<string> 完整的分析结果
 */
async function getServerVisionStreamAnalysis(
  serverUrl: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  onUpdate?: (text: string) => void
): Promise<string> {
  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: prompt
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64
            }
          }
        ]
      }
    ]
  };

  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/gemini/vision-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    throw new Error(`服务器视觉流式API调用失败: HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error('无法获取响应流');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let accumulatedText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      const chunkStr = decoder.decode(value, { stream: true });
      const lines = chunkStr.split('\n');
      
      for (const line of lines) {
        const trimmedLine = line.trim();
        
        // 解析SSE格式的数据
        if (trimmedLine.startsWith('data: ')) {
          const jsonStr = trimmedLine.slice(6); // 移除 'data: ' 前缀
          
          if (jsonStr === '[DONE]') {
            break;
          }
          
          try {
            const data = JSON.parse(jsonStr);
            
            // 检查是否是完成信号
            if (data.finishReason || data.status === 'completed') {
              break;
            }
            
            // 检查是否有错误
            if (data.error) {
              throw new Error(`后端服务器错误: ${data.error}`);
            }
            
            // 处理增量文本内容
            if (data.text && typeof data.text === 'string') {
              accumulatedText += data.text;
              
              if (onUpdate) {
                onUpdate(accumulatedText);
              }
              
              // 移除冗余日志：后端视觉流式数据接收
            }
            
            // 处理最终文本内容
            if (data.finalText && typeof data.finalText === 'string') {
              if (data.finalText && !accumulatedText.includes(data.finalText)) {
                accumulatedText += data.finalText;
              }
              
              if (onUpdate) {
                onUpdate(accumulatedText);
              }
              
              // 移除冗余日志：后端视觉分析最终增量
            }
            
          } catch (parseError) {
            // 忽略JSON解析错误，继续处理下一行
            console.warn('JSON解析失败:', parseError);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  
  if (!accumulatedText || accumulatedText.trim() === '') {
    throw new Error('后端服务器未返回有效的手相分析数据');
  }
  
  return accumulatedText.trim();
}

/**
 * 通过后端服务器进行标准视觉分析（非流式）
 * @param serverUrl 服务器URL
 * @param imageBase64 Base64编码的图像数据
 * @param mimeType 图像MIME类型
 * @param prompt 分析提示词
 * @returns Promise<string> 完整的分析结果
 */
async function getServerVisionStandardAnalysis(
  serverUrl: string,
  imageBase64: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: prompt
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.7,
      topK: 32,
      topP: 1,
      maxOutputTokens: 4096,
    }
  };

  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/gemini/vision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    throw new Error(`服务器视觉标准API调用失败: HTTP ${response.status}`);
  }

  const data = await response.json();
  
  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('服务器未返回有效的视觉分析数据');
  }
  
  const candidate = data.candidates[0];
  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new Error('服务器返回数据格式错误');
  }
  
  const analysisText = candidate.content.parts[0].text;
  
  if (!analysisText || analysisText.trim() === '') {
    throw new Error('服务器返回的视觉分析结果为空');
  }
  
  return analysisText.trim();
}

/**
 * 统一的服务器视觉分析函数，根据设置选择流式或非流式
 * @param serverUrl 服务器URL
 * @param imageBase64 Base64编码的图像数据
 * @param mimeType 图像MIME类型
 * @param prompt 分析提示词
 * @param enableStreaming 是否启用流式响应
 * @param onUpdate 流式更新回调函数（仅流式模式使用）
 * @returns Promise<string> 完整的分析结果
 */
async function getServerVisionAnalysis(
  serverUrl: string,
  imageBase64: string,
  mimeType: string,
  prompt: string,
  enableStreaming: boolean,
  onUpdate?: (text: string) => void
): Promise<string> {
  if (enableStreaming) {
    // 使用流式API
    return await getServerVisionStreamAnalysis(serverUrl, imageBase64, mimeType, prompt, onUpdate);
  } else {
    // 使用标准API
    const result = await getServerVisionStandardAnalysis(serverUrl, imageBase64, mimeType, prompt);
    
    // 如果有更新回调，模拟流式显示效果
    if (onUpdate && result) {
      const words = result.split('');
      const chunkSize = 3; // 每次显示3个字符
      const delay = 30; // 30ms延迟，模拟打字效果
      
      let currentText = '';
      
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join('');
        currentText += chunk;
        onUpdate(currentText);
        
        // 添加延迟以模拟流式效果
        if (i + chunkSize < words.length) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      // 确保最终显示完整文本
      onUpdate(result);
    }
    
    return result;
  }
}

/**
 * 手相分析流式处理 - 支持后端服务器和降级处理
 * @param imageBase64 Base64编码的图像数据
 * @param mimeType 图像MIME类型
 * @param master 选择的大师
 * @param onUpdate 流式更新回调函数
 * @param userInfo 用户信息（可选）
 * @returns Promise<string> 完整的分析结果
 */
export async function getPalmistryAnalysisStream(
  imageBase64: string,
  mimeType: string,
  master: Master,
  onUpdate?: (text: string) => void,
  userInfo?: any
): Promise<string> {
  try {
    console.log('开始手相分析...');
    
    // 1. 获取设置
    const state = useAppStore.getState();
    const { apiKey, serverUrl } = state.settings;
    const enableStreaming = ENABLE_STREAMING; // 使用代码中的开关
    
    // 2. 构建提示词
    const prompt = buildPrompt(master, {
      message: "请分析这张手相图片", 
      imageType: "palmistry"
    }, 'palmistry', userInfo);
    
    // 3. 如果配置了服务器URL，优先使用后端服务器
    if (serverUrl && serverUrl.trim()) {
      
      try {
        // 检查服务器健康状态
        const isServerHealthy = await checkServerHealth(serverUrl);
        
        if (isServerHealthy) {
          console.log(`后端服务器健康检查通过，使用服务器视觉${enableStreaming ? '流式' : '标准'}API...`);
          return await getServerVisionAnalysis(serverUrl, imageBase64, mimeType, prompt, enableStreaming, onUpdate);
        } else {
          console.warn('后端服务器健康检查失败，降级到直接API调用');
        }
      } catch (serverError) {
        console.warn('后端服务器手相分析调用失败，降级到直接API调用:', serverError);
      }
    }
    
    // 4. 降级到直接API调用
    console.log('使用直接手相分析API...');
    
    // 检查API密钥（只有在没有可用服务器时才强制要求）
    if (!hasValidApiKey(apiKey)) {
      if (serverUrl && serverUrl.trim()) {
        throw new Error('后端服务器不可用，且未配置有效的Gemini API密钥。请检查服务器状态或配置API密钥。');
      } else {
        throw new Error('请先在设置中配置有效的Gemini API密钥以进行手相分析');
      }
    }
    
    // 使用普通的手相分析API
    const fullAnalysis = await getPalmistryAnalysis(imageBase64, mimeType, master, userInfo);
    
    // 如果有更新回调，模拟流式显示效果
    if (onUpdate && fullAnalysis) {
      const words = fullAnalysis.split('');
      const chunkSize = 3; // 每次显示3个字符
      const delay = 30; // 30ms延迟，模拟打字效果
      
      let currentText = '';
      
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join('');
        currentText += chunk;
        onUpdate(currentText);
        
        // 添加延迟以模拟流式效果
        if (i + chunkSize < words.length) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      // 确保最终显示完整文本
      onUpdate(fullAnalysis);
    }
    
    return fullAnalysis;
    
  } catch (error) {
    console.error('手相分析失败:', error);
    
    // 重新抛出错误，让调用者处理
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error('手相分析失败，请重试');
    }
  }
}

/**
 * 验证Gemini API Key的有效性
 * @param apiKey 要验证的API Key
 * @returns Promise<boolean> 验证结果
 * @throws 当验证失败时抛出具体错误信息
 */
export async function validateGeminiApiKey(apiKey: string): Promise<boolean> {
  try {
    // 验证API Key格式 - Gemini API Key通常以AIza开头
    const trimmedKey = apiKey.trim();
    if (!isValidApiKeyFormat(trimmedKey)) {
      throw new Error('API Key格式不正确，Gemini API Key应该以AIza开头');
    }

    // 真实验证API Key - 调用Gemini API测试
    const response = await axios.get(
      buildModelsListUrl(trimmedKey),
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: GEMINI_CONFIG.REQUEST_CONFIG.VALIDATION_TIMEOUT,
      }
    );

    if (response.status === 200 && response.data) {
      console.log('API Key验证成功:', response.data);
      return true;
    } else {
      throw new Error('API响应异常');
    }

  } catch (error) {
    console.error('API Key验证失败:', error);

    if (axios.isAxiosError(error)) {
      if (error.response) {
        const status = error.response.status;
        switch (status) {
          case 400:
            throw new Error('API Key无效或已被禁用');
          case 403:
            throw new Error('API Key权限不足');
          case 429:
            throw new Error('API请求频率限制，请稍后再试');
          default:
            throw new Error(`验证失败: HTTP ${status}`);
        }
      } else if (error.request) {
        throw new Error('网络连接失败，请检查网络连接');
      }
    }

    // 处理超时错误
    if (error instanceof Error && 'code' in error && error.code === 'ECONNABORTED') {
      throw new Error('验证请求超时，请检查网络连接后重试');
    }

    // 重新抛出其他错误
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error('验证失败，请检查网络连接');
    }
  }
}

/**
 * Validate an API key for the *currently active* provider. Routes to the
 * right upstream depending on settings.provider. Falls back to a tiny
 * inference: gemini via direct REST, others via backend /api/llm/validate-key
 * (which is preferred because it doesn't require the browser to reach the
 * upstream directly).
 */
export async function validateProviderKey(
  providerId: string,
  apiKey: string,
  serverUrl?: string
): Promise<boolean> {
  const provider = getProviderCfg(providerId);
  const trimmedKey = (apiKey || '').trim();
  if (!provider.isValidApiKeyFormat(trimmedKey)) {
    throw new Error(`API Key格式不正确（${provider.displayName}）`);
  }

  // Prefer the backend probe when a server is configured.
  if (serverUrl && serverUrl.trim()) {
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/llm/validate-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider.id, apiKey: trimmedKey }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) return true;
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || `后端验证失败: HTTP ${response.status}`);
  }

  // Browser-side direct probe.
  if (provider.id === 'gemini') {
    return await validateGeminiApiKey(trimmedKey);
  }
  if (provider.id === 'minimax') {
    const url = `${provider.directBaseUrl.replace(/\/$/, '')}/models`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { ...provider.directAuthHeader(trimmedKey) },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) return true;
    const text = await resp.text().catch(() => '');
    throw new Error(`MiniMax 验证失败: HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  throw new Error('未实现的 provider 验证');
}

/**
 * 将File对象转换为base64字符串
 * @param file 图像文件
 * @returns Promise<{base64: string, mimeType: string}> base64数据和MIME类型
 */
export function convertImageToBase64(file: File): Promise<{base64: string, mimeType: string}> {
  return new Promise((resolve, reject) => {
    // 验证文件类型
    if (!isSupportedImageType(file.type)) {
      reject(new Error(`不支持的图片格式，请上传 ${GEMINI_CONFIG.FILE_CONFIG.SUPPORTED_IMAGE_TYPES.join(', ')} 格式的图片`));
      return;
    }
    
    // 验证文件大小
    if (!isValidFileSize(file.size)) {
      reject(new Error(`图片文件大小不能超过 ${(GEMINI_CONFIG.FILE_CONFIG.MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB`));
      return;
    }
    
    const reader = new FileReader();
    
    reader.onload = () => {
      try {
        const result = reader.result as string;
        // 移除data:image/...;base64,前缀，只保留base64数据
        const base64Data = result.split(',')[1];
        
        if (!base64Data) {
          reject(new Error('图片格式转换失败'));
          return;
        }
        
        resolve({
          base64: base64Data,
          mimeType: file.type
        });
      } catch (error) {
        reject(new Error('图片读取失败'));
      }
    };
    
    reader.onerror = () => {
      reject(new Error('图片读取失败'));
    };
    
    // 读取文件为data URL
    reader.readAsDataURL(file);
  });
}

/**
 * 图像生成响应接口
 */
interface GeminiImageGenerationResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text?: string;
        inline_data?: {
          mime_type: string;
          data: string;
        };
        inlineData?: {  // 添加驼峰命名支持
          mimeType: string;
          data: string;
        };
      }>;
    };
  }>;
}

/**
 * 服务器图像生成标准分析
 * @param serverUrl 服务器URL
 * @param imageBase64 Base64编码的图像数据
 * @param mimeType 图像MIME类型
 * @param prompt 生成提示词
 * @returns Promise<string> 生成的图像Base64数据URL
 */
async function getServerImageGenerationStandard(
  serverUrl: string,
  imageBase64: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: imageBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 1024,
      response_modalities: ["TEXT", "IMAGE"]
    }
  };

  const response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/gemini/image-generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(errorData.error || '图像生成失败');
  }

  const data: GeminiImageGenerationResponse = await response.json();
  
  if (!data.candidates || data.candidates.length === 0) {
    throw new Error('服务器未返回有效的图像生成数据');
  }
  
  const candidate = data.candidates[0];
  
  if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
    throw new Error('服务器返回数据格式错误');
  }
  
  // 查找包含图像数据的部分
  const imagePart = candidate.content.parts.find(part => part.inline_data || part.inlineData);
  if (!imagePart || (!imagePart.inline_data && !imagePart.inlineData)) {
    throw new Error('未能生成图像，请重试');
  }
  
  // 支持两种格式的图像数据
  let imageMimeType: string;
  let imageDataBase64: string;
  
  if (imagePart.inline_data) {
    imageMimeType = imagePart.inline_data.mime_type;
    imageDataBase64 = imagePart.inline_data.data;
  } else if (imagePart.inlineData) {
    imageMimeType = imagePart.inlineData.mimeType;
    imageDataBase64 = imagePart.inlineData.data;
  } else {
    throw new Error('未能解析图像数据格式');
  }
  
  // 构建完整的数据URL
  const generatedImageUrl = `data:${imageMimeType};base64,${imageDataBase64}`;
  
  return generatedImageUrl;
}

/**
 * 图像生成处理 - 支持后端服务器和降级处理
 * @param imageBase64 Base64编码的图像数据
 * @param mimeType 图像MIME类型
 * @param prompt 生成提示词
 * @returns Promise<string> 生成的图像Base64数据URL
 */
export async function getImageGeneration(
  imageBase64: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  try {
    console.log('开始图像生成...');
    
    // 1. 获取设置
    const state = useAppStore.getState();
    const { apiKey, serverUrl } = state.settings;
    
    // 2. 如果配置了服务器URL，优先使用后端服务器
    if (serverUrl && serverUrl.trim()) {
      
      try {
        // 检查服务器健康状态
        const isServerHealthy = await checkServerHealth(serverUrl);
        
        if (isServerHealthy) {
          console.log('后端服务器健康检查通过，使用服务器图像生成API...');
          return await getServerImageGenerationStandard(serverUrl, imageBase64, mimeType, prompt);
        } else {
          console.warn('后端服务器健康检查失败，降级到直接API调用');
        }
      } catch (serverError) {
        console.warn('后端服务器图像生成调用失败，降级到直接API调用:', serverError);
      }
    }
    
    // 3. 降级到直接API调用（如果需要的话，这里可以实现直接调用Gemini API）
    console.log('图像生成需要后端服务器支持');
    
    // 检查API密钥和服务器状态
    if (!serverUrl || !serverUrl.trim()) {
      throw new Error('图像生成功能需要配置后端服务器地址。请在设置中配置服务器URL。');
    } else {
      throw new Error('后端服务器不可用，图像生成功能暂时无法使用。请检查服务器状态。');
    }
    
  } catch (error) {
    console.error('图像生成失败:', error);
    
    // 重新抛出错误，让调用者处理
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error('图像生成失败，请重试');
    }
  }
} 