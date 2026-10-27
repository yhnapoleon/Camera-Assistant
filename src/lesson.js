const fail = message => { throw Error(`学习内容不完整：${message}。请重试生成。`); };
const text = (value, name, max = 12000, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) fail(name);
  return value.replace(/\r\n?/g, '\n').trimEnd();
};
const list = (value, name, min = 1, max = 30) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(name);
  return value;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const labels = (value, name) => list(value, name, 1, 8).map(s => text(s, name, 120));

export function validateLesson(data) {
  if (!object(data) || data.version !== 1) fail('数据版本');
  const numbers = new Set();
  const problems = list(data.problems, '编程题', 1, 12).map(p => {
    if (!object(p)) fail('题目');
    const no = text(p.no, '题号', 30);
    if (numbers.has(no)) fail('题号重复'); numbers.add(no);
    const steps = list(p.steps, '实现步骤', 1, 16).map(s => {
      if (!object(s) || !/^S[1-9]\d?$/.test(s.id)) fail('步骤编号');
      return { id: s.id, title: text(s.title, '步骤标题', 120), goal: text(s.goal, '步骤目的'), state: text(s.state, '步骤状态'), action: text(s.action, '步骤操作'), boundary: text(s.boundary, '边界条件') };
    });
    const ids = new Set(steps.map(s => s.id));
    if (ids.size !== steps.length) fail('步骤编号重复');
    if (!object(p.analysis)) fail('分析');
    const analysis = Object.fromEntries(['why', 'correctness', 'time', 'space'].map(k => [k, text(p.analysis[k], `分析 ${k}`)]));
    const d = p.diagram;
    if (!object(d) || !['题面示例', '演示示例'].includes(d.exampleSource)) fail('图解示例来源');
    const nodes = list(d.nodes, '图节点', 1, 32).map(n => {
      if (!object(n) || !/^[a-zA-Z0-9_-]{1,40}$/.test(n.id) || !ids.has(n.step)) fail('图节点步骤');
      return { id: n.id, step: n.step, label: text(n.label, '图节点文字', 180) };
    });
    const nodeIds = new Set(nodes.map(n => n.id));
    if (nodeIds.size !== nodes.length || steps.some(s => !nodes.some(n => n.step === s.id))) fail('图节点覆盖');
    const edges = list(d.edges, '图连线', 0, 64).map(e => {
      if (!object(e) || !nodeIds.has(e.from) || !nodeIds.has(e.to)) fail('图连线引用');
      return { from: e.from, to: e.to, label: text(e.label, '连线文字', 100, true) };
    });
    const variants = {};
    for (const mode of ['leetcode', 'acm']) {
      const v = p.variants?.[mode]; if (!object(v)) fail(`${mode} 代码`);
      let line = 1;
      const blocks = list(v.blocks, `${mode} 代码块`, 1, 50).map(b => {
        if (!object(b) || !['core', 'support'].includes(b.role) || (b.step !== '' && !ids.has(b.step))) fail(`${mode} 代码步骤引用`);
        const code = text(b.code, `${mode} 源码`, 50000);
        const start = line; line += code.split('\n').length;
        return { step: b.step, role: b.role, title: text(b.title, '代码块标题', 160), code, start, end: line - 1 };
      });
      if (line > 4000 || steps.some(s => !blocks.some(b => b.step === s.id)) || !blocks.some(b => b.role === 'core') || !blocks.some(b => b.role === 'support')) fail(`${mode} 完整代码或步骤覆盖`);
      variants[mode] = { filename: text(v.filename, '文件名', 120), blocks, code: blocks.map(b => b.code).join('\n'), submission: blocks.filter(b => b.role === 'core').map(b => b.code).join('\n'), command: text(v.command, '运行命令', 1000), input: text(v.input, '样例输入', 12000, true), output: text(v.output, '预期输出', 12000, true), notes: text(v.notes, '运行说明', 6000) };
    }
    return { no, title: text(p.title, '题目标题', 200), summary: text(p.summary, '题意'), language: text(p.language, '语言', 40), draft: ['none', 'part', 'full'].includes(p.draft) ? p.draft : 'none', categories: labels(p.categories, '分类'), approaches: labels(p.approaches, '思路'), analysis, steps, diagram: { title: text(d.title, '图标题', 200), exampleSource: d.exampleSource, example: text(d.example, '图示例'), nodes, edges }, variants };
  });
  return { version: 1, title: text(data.title, '标题', 200), answer: text(data.answer ?? '', '普通题答案', 24000, true), problems };
}

export function parseLesson(raw) {
  let source = String(raw || '').trim();
  if (/^```(?:json)?\s*\n/i.test(source)) source = source.replace(/^```(?:json)?\s*\n/i, '').replace(/\n```\s*$/, '').trim();
  if (!source.startsWith('{')) return null;
  if (source.length > 600000) fail('内容过长');
  let payload; try { payload = JSON.parse(source); } catch { fail('JSON 被截断或格式不正确'); }
  const lesson = validateLesson(payload);
  const insights = lesson.problems.map(p => ({ no: p.no, summary: p.summary, categories: p.categories, approaches: p.approaches, draft: p.draft }));
  // Keep the legacy answer surface for explanations and list matching, with core code only.
  const answer = [lesson.answer, ...lesson.problems.map(p => `第 ${p.no} 题\n\`\`\`${p.language}\n${p.variants.leetcode.submission}\n\`\`\``)].filter(Boolean).join('\n\n');
  return { title: lesson.title, answer, kind: 'code', insights, lesson };
}

export const LESSON_PROMPT = `
【新版编程题学习协议：优先于上面所有旧版编程题输出格式规则】
仅有普通题或没有题目时继续使用原格式。只要含有可解的编程题，整个回答必须是一个 JSON 对象（不要代码围栏、不要前言），一次生成全部教学说明、图解和两种完整运行方案。看不清或关键条件不足的题只写入 answer 说明无法确定，不编造解法。
对象结构如下，括号里的说明不是输出内容：
{"version":1,"title":"目录标题","answer":"同批普通题答案或无法确定的题，没有则空字符串","problems":[{
"no":"1","title":"题名","summary":"输入、目标、关键条件","language":"python","draft":"none",
"categories":["题目类型"],"approaches":["解法标签"],
"analysis":{"why":"根据具体题目条件说明为什么选这个算法，必要时对比朴素做法","correctness":"关键不变量或正确性依据","time":"复杂度及理由","space":"复杂度及理由"},
"steps":[{"id":"S1","title":"步骤名","goal":"目的","state":"变量或状态含义","action":"具体操作","boundary":"边界情况及处理"}],
"diagram":{"title":"图标题","exampleSource":"题面示例或演示示例，二选一","example":"一个具体输入的关键变化及输出","nodes":[{"id":"n1","step":"S1","label":"具体状态、数据或操作，最多180字符"}],"edges":[{"from":"n1","to":"n2","label":"条件或变化"}]},
"variants":{"leetcode":{"filename":"solution.py","blocks":[{"step":"S1","title":"与步骤对应的代码标题","role":"core","code":"此代码块的源代码，保留缩进，用JSON换行转义"},{"step":"","title":"本地入口与测试数据","role":"support","code":"完整运行入口"}],"command":"python solution.py","input":"无需输入，测试数据在入口中","output":"精确预期输出","notes":"哪些只供本地运行、哪些提交到平台"},"acm":{"filename":"main.py","blocks":[],"command":"python main.py < input.txt","input":"完整样例输入","output":"精确预期输出","notes":"输入输出约定"}}
}]}
严格要求：
1. steps 的编号唯一，为 S1、S2…，每题1到16步。每步在两个版本代码和图节点中都有对应。图节点id唯一，连线只能指向本题已定义节点。用节点和连线表示真实流程/数据结构/状态变化，引用具体示例，不只重复标题。
2. 两个版本都必须有完整 blocks（上面的acm空数组只是字段示意，不允许实际留空）。按源码顺序连接所有 code（中间一个换行）后必须是完整、可本地运行的程序，保持跨块缩进/括号正确。不用省略号、伪代码、TODO。每块最多50000字符，整份不超过4000行。
3. blocks.role=core 的代码连接后是可提交的核心实现（含需要的导入），support 是本地辅助结构、测试数据、输入输出与入口。辅助块step可为空。每个S编号至少在各版本一个代码块中出现。不要让 core 引用仅在 support 定义的平台不提供的自定义函数；LeetCode 自带节点类型可在本地 support 中定义。
4. 默认 LeetCode 版采用 Solution/题目函数签名，并附完整本地调用与测试数据。Python 必须包含 if __name__ == "__main__":；其他语言使用其真实入口。补齐链表、树等本地定义、构造及输出。明确区分平台提交代码和本地辅助代码。
5. ACM版实现标准输入读取和标准输出，包含main或等效入口。两版使用同一语言、同一算法、同样的步骤编号。题面指定了输入格式就照题面；没有时自行设计并在notes明确标为“本地约定”。样例必须能按command运行并得到output。
6. 沿用语言选择、清晰变量名、中文解释注释和已有代码补全规则。draft 用 none/part/full 表示已有代码情况；part/full 时在原解法上修复，改动保留“改：”“补：”注释。代码关键步骤注释说明为什么，不能只说“处理”。语言不明时Python。
7. 所有问题的no唯一，最多12道。多题和混合题不要丢题。所有字符串都按JSON正确转义。分析、图解和两种代码必须基于同一份解法，不要为了匹配某个题单题名改变题意。
`;
