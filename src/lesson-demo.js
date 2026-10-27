export function demoLesson() {
  const blocks = [
    { step: 'S1', title: '记录已经见过的数', role: 'core', code: 'class Solution:\n    def twoSum(self, nums, target):\n        # S1：值映射到下标，便于查找配对数。\n        seen = {}' },
    { step: 'S2', title: '查找当前数的配对数', role: 'core', code: '        # S2：先查再存，避免使用同一个下标。\n        for index, number in enumerate(nums):\n            needed = target - number\n            if needed in seen:\n                return [seen[needed], index]' },
    { step: 'S3', title: '保存当前数供后续查找', role: 'core', code: '            # S3：当前值只供后续位置使用。\n            seen[number] = index\n        return []' },
  ];
  return { version: 1, title: '演示：两数之和（未调用模型）', answer: '', problems: [{
    no: '1', title: '两数之和', summary: '给定整数数组和目标值，找出和为目标值的两个不同下标。', language: 'python', draft: 'none',
    categories: ['数组', '哈希表'], approaches: ['补数查找', '先查后存'],
    analysis: { why: '每个数只需要查找 target-number，哈希表可以避免重复扫描。', correctness: '遍历当前下标之前，表中只含更早的元素，因此不会重复使用当前元素，且不会漏掉配对。', time: 'O(n)，每个元素查找和写入一次。', space: 'O(n)，保存已遍历的元素。' },
    steps: [
      { id: 'S1', title: '建立索引表', goal: '快速寻找配对数', state: 'seen 保存数值到下标的映射', action: '初始化空字典', boundary: '没有答案时返回空列表' },
      { id: 'S2', title: '检查补数', goal: '找到两个不同下标', state: '当前下标 index、数值 number', action: '计算 needed 并查表，命中就返回', boundary: '先查表再保存当前元素' },
      { id: 'S3', title: '保存并继续', goal: '为后续元素提供候选', state: 'seen 包含到当前位置为止的数', action: '保存 number 的下标，继续遍历', boundary: '重复数字也可在下一次被匹配' },
    ],
    diagram: { title: '补数查找流程', exampleSource: '演示示例', example: 'nums=[2,7,11,15]，target=9；处理 7 时查到 2，返回 [0,1]。', nodes: [{ id: 'init', step: 'S1', label: 'seen = {}' }, { id: 'find', step: 'S2', label: '查找 target - number；找到则返回两个下标' }, { id: 'store', step: 'S3', label: '未找到：保存当前数及下标' }], edges: [{ from: 'init', to: 'find', label: '遍历' }, { from: 'find', to: 'store', label: '未命中' }, { from: 'store', to: 'find', label: '下一个数' }] },
    variants: {
      leetcode: { filename: 'solution.py', blocks: [...blocks, { step: '', role: 'support', title: '本地入口与测试数据（不提交到 LeetCode）', code: '# 本地运行测试，平台提交时无需此段。\nif __name__ == "__main__":\n    nums = [2, 7, 11, 15]\n    target = 9\n    print(Solution().twoSum(nums, target))' }], command: 'python solution.py', input: '无需标准输入，测试数据写在入口中。', output: '[0, 1]', notes: '核心部分提交到 LeetCode；完整程序用于本地运行。' },
      acm: { filename: 'main.py', blocks: [...blocks, { step: '', role: 'support', title: '标准输入与输出', code: '# 本地约定：第一行 n target，第二行 n 个整数。\nif __name__ == "__main__":\n    import sys\n    values = list(map(int, sys.stdin.read().split()))\n    count, target = values[:2]\n    nums = values[2:2 + count]\n    result = Solution().twoSum(nums, target)\n    print(*result)' }], command: 'python main.py < input.txt', input: '4 9\n2 7 11 15', output: '0 1', notes: '本地约定：第一行 n target；第二行 n 个整数。原 LeetCode 题未指定标准输入格式。' },
    },
  }] };
}

