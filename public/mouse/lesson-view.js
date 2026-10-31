/* Read-only lesson views. Model text only enters textContent or the escaping highlighter. */
(() => {
  const STAGES = [['insight', '概览'], ['analysis', '思路分析'], ['implementation', '具体实现'], ['diagram', '结构图解'], ['code', '代码']];
  const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
  function button(text, action, data = {}) {
    const b = el('button', text); b.type = 'button'; b.dataset.action = 'lesson'; Object.assign(b.dataset, data);
    b.onclick = event => { event.stopPropagation(); action(); }; return b;
  }
  function section(title, text, className = '') {
    const node = el('section', undefined, `lesson-card ${className}`); node.append(el('h3', title), el('p', text)); return node;
  }
  const svgNode = (tag, attrs, text) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs || {})) n.setAttribute(key, value);
    if (text !== undefined) n.textContent = text; return n;
  };
  function graph(problem, callbacks) {
    const diagram = problem.diagram, wrap = el('section', undefined, 'lesson-card diagram-card');
    wrap.append(el('h3', diagram.title), el('p', `${diagram.exampleSource} · ${diagram.example}`, 'diagram-example'));
    const tools = el('div', undefined, 'lesson-tools');
    const viewport = el('div', undefined, 'diagram-viewport'); viewport.dataset.action = 'lesson';
    const width = 720, rowHeight = 154, height = diagram.nodes.length * rowHeight + 40;
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': diagram.title, class: 'lesson-graph' });
    const defs = svgNode('defs');
    const marker = svgNode('marker', { id: 'lesson-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(svgNode('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#82b8a6' })); defs.append(marker); svg.append(defs);
    const positions = new Map(diagram.nodes.map((n, i) => [n.id, { x: 110, y: 20 + i * rowHeight }]));
    for (const edge of diagram.edges) {
      const a = positions.get(edge.from), b = positions.get(edge.to), forward = b.y > a.y;
      const route = forward ? `M 330 ${a.y + 110} L 330 ${b.y}` : `M 550 ${a.y + 65} L 636 ${a.y + 65} L 636 ${b.y + 40} L 550 ${b.y + 40}`;
      svg.append(svgNode('path', { d: route, fill: 'none', stroke: '#82b8a6', 'stroke-width': 2, 'marker-end': 'url(#lesson-arrow)', class: 'diagram-edge' }));
      const label = svgNode('text', { x: forward ? 342 : 640, y: forward ? (a.y + 110 + b.y) / 2 + 4 : (a.y + b.y) / 2 + 40, class: 'diagram-edge-label' });
      const chars = Array.from(edge.label); const chunks = [];
      for (let i = 0; i < chars.length; i += 12) chunks.push(chars.slice(i, i + 12).join(''));
      for (let i = 0; i < Math.min(chunks.length, 3); i++) label.append(svgNode('tspan', { x: forward ? 342 : 640, dy: i ? 16 : 0 }, chunks[i]));
      const title = svgNode('title', {}, edge.label); label.append(title); svg.append(label);
    }
    for (const node of diagram.nodes) {
      const pos = positions.get(node.id), group = svgNode('g', { role: 'button', tabindex: 0, 'aria-label': `${node.step} ${node.label}，查看代码`, 'data-action': 'lesson', 'data-step-link': node.step });
      group.append(svgNode('rect', { x: pos.x, y: pos.y, width: 440, height: 110, rx: 14, class: 'diagram-node' }));
      group.append(svgNode('text', { x: pos.x + 18, y: pos.y + 25, class: 'diagram-step' }, node.step));
      const label = svgNode('text', { x: pos.x + 18, y: pos.y + 51, class: 'diagram-node-label' });
      const chars = Array.from(node.label);
      for (let i = 0; i < Math.min(Math.ceil(chars.length / 26), 3); i++) label.append(svgNode('tspan', { x: pos.x + 18, dy: i ? 22 : 0 }, chars.slice(i * 26, (i + 1) * 26).join('') + (i === 2 && chars.length > 78 ? '…' : '')));
      group.append(label, svgNode('title', {}, node.label));
      group.onclick = event => { event.stopPropagation(); callbacks.step(node.step); };
      group.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); callbacks.step(node.step); } };
      svg.append(group);
    }
    let zoom = 1;
    const zoomLabel = el('span', '100%', 'lesson-muted');
    function size(delta) { zoom = delta === 0 ? 1 : Math.max(.6, Math.min(2.5, zoom + delta)); svg.style.width = `${720 * zoom}px`; zoomLabel.textContent = `${Math.round(zoom * 100)}%`; }
    tools.append(button('− 缩小', () => size(-.2)), zoomLabel, button('＋ 放大', () => size(.2)), button('重置', () => size(0)));
    size(0); viewport.append(svg); wrap.append(tools, viewport, el('p', '点击图中步骤可查看对应代码。图内可滚动，长文字的完整说明见下方。', 'lesson-muted'));
    const legend = el('ol', undefined, 'diagram-legend');
    for (const node of diagram.nodes) { const li = el('li'); li.append(button(node.step, () => callbacks.step(node.step)), el('span', node.label)); legend.append(li); }
    wrap.append(legend); return wrap;
  }
  function codeView(problem, mode, callbacks) {
    const variant = problem.variants[mode], root = el('section', undefined, 'lesson-code');
    const tools = el('div', undefined, 'lesson-tools mode-tools');
    for (const [id, label] of [['leetcode', 'LeetCode · 本地运行'], ['acm', 'ACM · 标准输入输出']]) {
      const b = button(label, () => callbacks.mode(id), { mode: id }); b.setAttribute('aria-pressed', String(mode === id)); tools.append(b);
    }
    tools.append(button('复制完整代码', () => callbacks.copy(variant.code), { copy: 'full' }));
    if (mode === 'leetcode') tools.append(button('复制提交代码', () => callbacks.copy(variant.submission), { copy: 'core' }));
    root.append(tools, section(mode === 'leetcode' ? '本地运行与平台提交' : '输入输出约定', variant.notes));
    const jumps = el('nav', undefined, 'lesson-tools'); jumps.setAttribute('aria-label', '跳到代码步骤');
    for (const step of problem.steps) jumps.append(button(`${step.id} ${step.title}`, () => callbacks.step(step.id)));
    root.append(jumps);
    const editor = el('div', undefined, 'code-editor'); editor.dataset.action = 'lesson';
    editor.append(el('div', `${variant.filename}  ·  ${problem.language}  ·  只读`, 'editor-tab'));
    const language = { 'c++': 'cpp', 'c#': 'csharp', py: 'python', js: 'javascript', ts: 'typescript' }[problem.language.toLowerCase()] || problem.language.toLowerCase();
    for (const block of variant.blocks) {
      const group = el('section', undefined, `code-block ${block.role}`); group.dataset.codeStep = block.step;
      group.append(el('h4', `${block.step || '辅助'} · ${block.title}${block.role === 'support' ? ' · 本地运行' : ''}`, 'code-block-title'));
      // Highlight the full block first so multiline strings/comments retain their token state.
      const highlighted = el('code');
      if (window.hljs?.getLanguage(language)) highlighted.innerHTML = window.hljs.highlight(block.code, { language, ignoreIllegals: true }).value;
      else highlighted.textContent = block.code;
      const pre = el('pre', undefined, 'source-code');
      // Split token nodes at newlines, retaining nested token classes and indentation.
      let line = el('span', undefined, 'source-line'), number = block.start;
      const pushLine = () => { line.dataset.line = String(number++); pre.append(line); line = el('span', undefined, 'source-line'); };
      function walk(node, classes = []) {
        if (node.nodeType === 3) {
          const parts = node.textContent.split('\n');
          parts.forEach((part, i) => { if (i) pushLine(); if (part) { const token = el('span', part, classes.join(' ')); line.append(token); } });
        } else for (const child of node.childNodes) walk(child, [...classes, ...(node.className ? String(node.className).split(' ') : [])]);
      }
      for (const node of highlighted.childNodes) walk(node);
      pushLine(); group.append(pre); editor.append(group);
    }
    root.append(editor);
    const run = el('section', undefined, 'lesson-card run-card'); run.dataset.action = 'lesson';
    run.append(el('h3', '运行方案'), el('p', '按下列命令在本地运行；预期输出由解答提供，未在服务器执行。', 'lesson-muted'));
    for (const [title, value, kind] of [['运行命令', variant.command, 'command'], ['样例输入 / 测试数据', variant.input || '（空输入）', 'input'], ['预期输出', variant.output || '（空输出）', 'output']]) {
      const row = el('div', undefined, 'run-section'); row.append(el('h4', title), el('pre', value), button('复制', () => callbacks.copy(kind === 'input' ? variant.input : kind === 'output' ? variant.output : value), { copy: kind })); run.append(row);
    }
    root.append(run); return root;
  }
  function render(lesson, state, callbacks) {
    const { stage, mode = 'leetcode' } = state, index = Math.max(0, Math.min(lesson.problems.length - 1, state.problemIndex || 0));
    const problem = lesson.problems[index], root = el('div', undefined, 'lesson-reader');
    const nav = el('nav', undefined, 'lesson-stages'); nav.setAttribute('aria-label', '学习阶段');
    for (const [id, title] of STAGES) { const b = button(title, () => callbacks.navigate(id), { stage: id }); if (id === stage) b.setAttribute('aria-current', 'step'); nav.append(b); }
    root.append(nav);
    if (lesson.problems.length > 1) {
      const picker = el('nav', undefined, 'lesson-tools problem-picker'); picker.setAttribute('aria-label', '选择题目');
      lesson.problems.forEach((p, i) => { const b = button(`第 ${p.no} 题 · ${p.title}`, () => callbacks.problem(i), { problem: String(i) }); b.setAttribute('aria-pressed', String(i === index)); picker.append(b); }); root.append(picker);
    }
    const heading = el('div', undefined, 'lesson-heading'); heading.append(el('span', `PROBLEM ${problem.no} / ${problem.language.toUpperCase()}`, 'lesson-eyebrow'), el('h2', problem.title), el('p', problem.summary)); root.append(heading);
    if (stage === 'insight') {
      root.append(section('题目类型', problem.categories.join(' · ')), section('解法路径', problem.approaches.join(' → ')));
      if (problem.draft !== 'none') root.append(section('已有代码', '解法沿用已有代码补全或修正。代码中的“改：”“补：”标记说明修改原因。'));
      if (lesson.answer) { const ordinary = section('同批其他题目', lesson.answer); ordinary.append(button('查看普通题解析', () => callbacks.explain(), { ordinaryExplain: 'true' })); root.append(ordinary); }
    } else if (stage === 'analysis') {
      root.append(section('题目类型', problem.categories.join(' · ')), section('为什么使用这个方法', problem.analysis.why, 'method-reason'), section('为什么这样做是正确的', problem.analysis.correctness));
      const costs = el('div', undefined, 'lesson-costs'); costs.append(section('时间复杂度', problem.analysis.time), section('空间复杂度', problem.analysis.space)); root.append(costs);
    } else if (stage === 'implementation') {
      for (const step of problem.steps) {
        const card = el('section', undefined, 'lesson-card step-card'); card.dataset.stepCard = step.id;
        card.append(el('h3', `${step.id} · ${step.title}`));
        for (const [label, value] of [['目标', step.goal], ['状态 / 变量', step.state], ['具体操作', step.action], ['边界', step.boundary]]) { const p = el('p'); p.append(el('b', `${label}：`), document.createTextNode(value)); card.append(p); }
        card.append(button('查看对应代码 ↗', () => callbacks.step(step.id), { stepLink: step.id })); root.append(card);
      }
    } else if (stage === 'diagram') root.append(graph(problem, callbacks));
    else if (stage === 'code') root.append(codeView(problem, mode, callbacks));
    const footer = el('nav', undefined, 'lesson-tools lesson-footer'), position = STAGES.findIndex(([id]) => id === stage);
    if (position > 0) footer.append(button(`‹ ${STAGES[position - 1][1]}`, () => callbacks.navigate(STAGES[position - 1][0])));
    if (position < STAGES.length - 1) footer.append(button(`${STAGES[position + 1][1]} ›`, () => callbacks.navigate(STAGES[position + 1][0])));
    root.append(footer); return root;
  }
  window.LessonView = { render, stages: STAGES.map(([id]) => id) };
})();
