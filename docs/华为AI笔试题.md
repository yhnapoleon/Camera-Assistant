# 华为 AI 笔试题

来源：用户提供的《华为_AI方向机考_笔经_2026-10-14.html》，录入于 2026-10-30。以下是笔经中的第 2、3 题，不补造缺失的第 1 题。代码保留原文（仅规范换行），三个题面样例已本地运行核验，不代表全范围正确。

原始文件的 SHA-256、题面与参考答案保存在 `src/reference-problems.json`。原题沿用参考解法，变式按当前题面调整，仍生成分步教学与两种运行模式。

本次验证：115 项自动测试通过；三个原始样例的 Python 输出均与题面一致。真实模型对照验证了 E29 原题、E30 原题、改变切分规则的 E30 变式，以及不相关的“两数之和”。这不是所有截图与所有变式的正确性保证。

## 当前本机服务加载方式

题库随解析服务启动加载。当前 8793 进程仍运行旧代码；此前自动审批拒绝了停止旧进程的操作（仅返回 `blocked by policy`），本次没有再次终止它。关闭原 8793 解析服务后，在项目目录的 PowerShell 执行以下命令，继续使用原来的新版数据目录、地址和配对码：

```powershell
$env:MOUSE_DATA_DIR = Join-Path (Get-Location) 'data\mouse-guided-20261028'
$env:MOUSE_PORT = '8793'
$env:MOUSE_HTTPS_PORT = '8794'
npm run start:mouse
```

然后刷新平板页面并重新扫描。采集端地址仍为 `http://192.168.0.21:8793`，无需因录入题库而更改或重启。

## E29 Masked Fused RMSNorm 算子数值实现

来源题号：第 2 题。

在轻量化大模型推理引擎中，Transformer 的隐藏状态会在多个子模块之间不断传递。为减少内存读写、提高推理效率，工程实现里常把若干操作并进同一个算子，例如：
残差连接 Residual Add
RMSNorm 归一化
逐元素缩放 Scale
逐元素偏置 Bias
Padding Mask 处理

请按下列步骤，实现一个简化的 Masked Fused RMSNorm。
计算步骤
对第 $k$ 个样本，输入向量记为 $x_k$，同时给出残差向量 $r_k$、残差系数 $\alpha_k$、有效长度 $l_k$、缩放向量 $\gamma$、偏置向量 $\beta$ 和数值稳定项 $\epsilon$。
1. 残差融合
$h_{k,i} = x_{k,i} + \alpha_k \cdot r_{k,i}$
2. 有效部分的 RMS 与 energy
只有前 $l_k$ 个位置是有效位置，其后一律视为 padding，不参与 RMS 与 energy。
$energy_k = \sum_{i=1}^{l_k} h_{k,i}^2$
$RMS_k = \sqrt{\frac{energy_k}{d_k} + \epsilon}$
其中 $d_k = \max(l_k, 1)$。
3. 归一化输出
输出向量 $y_k$ 按位置取值：
有效位置（$1 \le i \le l_k$）： $y_{k,i} = \gamma_i \cdot \frac{h_{k,i}}{RMS_k} + \beta_i$
无效位置（$l_k < i \le n$）： $y_{k,i} = 0$

任务说明
给定 $m$ 个样本。对每个样本输出三项：
Masked Fused RMSNorm 之后的结果向量 $y_k$
该样本有效部分的 $RMS_k$
该样本有效部分的平方和 $energy_k$

输入
第一行三个数 $m$ $n$ $\epsilon$：样本个数、每个向量的最大长度、RMSNorm 的数值稳定项。 第二行 $n$ 个浮点数，依次为缩放向量 $\gamma_1, \gamma_2, \dots, \gamma_n$。 第三行 $n$ 个浮点数，依次为偏置向量 $\beta_1, \beta_2, \dots, \beta_n$。 随后 $m$ 行，每行一个样本，格式为： $l$ $\alpha$ $x_1$ $x_2$ $\dots$ $x_n$ $r_1$ $r_2$ $\dots$ $r_n$ 其中：
$l$ 是当前样本的有效长度
$\alpha$ 是残差系数
$x_1 \dots x_n$ 是输入向量
$r_1 \dots r_n$ 是残差向量

数据范围
$1 \le m \le 200$
$1 \le n \le 256$
$0 \le l_k \le n$
$0 \le \epsilon \le 1$
$-10^8 \le x_{k,i}, r_{k,i} \le 10^8$
$-10^3 \le \gamma_i, \beta_i \le 10^3$
$-10^3 \le \alpha_k \le 10^3$

输出
共 $m$ 行，每行对应一个样本： $y_1$ $y_2$ $\dots$ $y_n$ $|$ $RMS$ $|$ $energy$
要求：
相邻数据之间只用一个空格，| 左右也各有一个空格；
全部浮点数保留两位小数，并按标准四舍五入；
不要输出 -0.00。绝对值小于 0.005 的数一律写成 0.00。

样例 1
输入：
2 3 0.5
1.0 1.0 1.0
0.0 2.0 -1.0
3 1.0 2.0 1.0 2.0 1.0 1.0 0.0
2 1.0 0.0 0.0 9.0 0.0 0.0 8.0
输出：
1.21 2.81 -0.19 | 2.48 | 17.00
0.00 2.00 0.00 | 0.71 | 0.00
解释： 第 1 个样本中，$l=3$，$\alpha=1.0$，残差融合后 $h = x + \alpha r = [3,\ 2,\ 2]$。 因此 $energy = 3^2 + 2^2 + 2^2 = 17$， $RMS = \sqrt{\frac{17}{3} + 0.5} \approx 2.4833$， 保留两位小数为 $2.48$。 再按 $y_i = \gamma_i \cdot \frac{h_i}{RMS} + \beta_i$ 计算，三个分量约是 $1.2081$、$2.8054$、$-0.1946$，保留两位小数后为 1.21 2.81 -0.19。
第 2 个样本中，$l=2$，$\alpha=1.0$。前两个位置融合后都是 $0$，第三个位置属于 padding，不计入 energy。 于是 $energy = 0$， $RMS = \sqrt{0.5} \approx 0.7071$，保留两位小数为 $0.71$。 有效位置上 $h_i = 0$，输出等于对应的 $\beta_i$；无效位置输出 $0$。该行为 0.00 2.00 0.00。
样例 2
输入：
2 3 0.000004
2.0 1.0 0.5
1.0 0.0 -1.0
3 0.0 2.0 2.0 4.0 1.0 3.0 3.0
0 1.0 6.0 6.0 6.0 2.0 2.0 2.0
输出：
2.41 0.71 -0.29 | 2.83 | 24.00
0.00 0.00 0.00 | 0.00 | 0.00
解释： 第 1 个样本的残差系数是 $0$，残差向量不进入融合： $h = [2,\ 2,\ 4]$， $energy = 2^2 + 2^2 + 4^2 = 24$， $RMS = \sqrt{\frac{24}{3} + 0.000004} \approx 2.8284$， 保留两位小数为 $2.83$。 代入缩放与偏置后，三个分量约是 $2.4142$、$0.7071$、$-0.2929$，保留两位小数为 2.41 0.71 -0.29。
第 2 个样本 $l = 0$，没有有效元素，因此 $energy = 0$， $RMS = \sqrt{0.000004} = 0.002$。 保留两位小数后为 $0.00$，输出向量也全部是 $0.00$。
提示
四舍五入
统一保留两位小数，不足两位要补零；
不要输出 -0.00，应写成 0.00。

输出格式
每行依次是 $n$ 个结果、一个 |、$RMS$、一个 |、$energy$；
空格和换行按上面的格式书写，不要多输出字符；
$\gamma$、$\beta$ 按下标 $i$ 取，不要和样本编号 $k$ 混用。

解法　逐样本照公式算：$h=x+\alpha r$；只对前 $l$ 个位置求 $energy$；$RMS=\sqrt{energy/\max(l,1)+\epsilon}$；有效位置输出 $\gamma_i h_i/RMS+\beta_i$，其余输出 0。

易错点　$\gamma$、$\beta$ 按位置下标取；$l=0$ 时分母取 1，$RMS=\sqrt{\epsilon}$，输出向量全为 0；按标准四舍五入，Python 的 round 和 %.2f 在 x.xx5 上可能舍掉，用 Decimal 的 ROUND_HALF_UP；绝对值小于 0.005 写成 0.00；“|” 两侧各一个空格；数值可到 $10^8$ 级，energy 可达 $10^{24}$ 级，用浮点数计算。

**已知限制：** 原题允许 epsilon=0，但未定义 l>0 且 energy=0 导致 RMS 为 0 时的 0/0 行为；参考代码会除零，不能将其称为全输入范围已验证。遇到该情形应说明条件缺失，以当前题面补充规则为准。

### 原始参考答案

```python
import sys
import math
from decimal import Decimal, ROUND_HALF_UP


def fmt(v):
    if abs(v) < 0.005:                        # 不输出 -0.00
        return '0.00'
    d = Decimal(repr(v)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return format(d, 'f')


def main():
    data = sys.stdin.read().split()
    m, n, eps = int(data[0]), int(data[1]), float(data[2])
    pos = 3
    gamma = [float(v) for v in data[pos:pos + n]]
    pos += n
    beta = [float(v) for v in data[pos:pos + n]]
    pos += n
    out = []
    for _ in range(m):
        l = int(float(data[pos]))
        alpha = float(data[pos + 1])
        x = [float(v) for v in data[pos + 2:pos + 2 + n]]
        r = [float(v) for v in data[pos + 2 + n:pos + 2 + 2 * n]]
        pos += 2 + 2 * n
        h = [x[i] + alpha * r[i] for i in range(n)]          # 残差融合
        energy = sum(h[i] * h[i] for i in range(l))          # 只算前 l 个有效位置
        rms = math.sqrt(energy / max(l, 1) + eps)
        y = [gamma[i] * h[i] / rms + beta[i] if i < l else 0.0 for i in range(n)]
        out.append(' '.join(fmt(v) for v in y) + ' | ' + fmt(rms) + ' | ' + fmt(energy))
    print('\n'.join(out))


main()
```

## E30 用 CART 分类树预测客户是否购房

来源题号：第 3 题。

CART（Classification and Regression Trees）分类树通过二元切分，递归地把样本划入不纯度更低的子集。分裂特征和切分点由基尼指数（Gini Index）算出，得到一棵二叉树；离散取值和连续取值都可以参与分裂。 本题用这棵 CART 分类树预测客户是否购房。根据训练集建出二叉决策树，每个节点按基尼指数选择特征和切分点，再对测试样本给出预测。
划分规则： 对每一个特征，把它所有可能的取值逐一当作切分点，当前节点的样本分成左子集和右子集：
左子集：特征值 = 切分点
右子集：特征值 ≠ 切分点

数据集说明
每条记录包含 4 个特征和 1 个标签，输入时全部写成整数枚举。
特征1： 年龄段（0：18-30岁；1：31-40岁；2：41-55岁；3：56岁及以上）
特征2： 婚姻状况（0：单身；1：恋爱；2：已婚）
特征3： 是否有房（0：无；1：有）
特征4： 是否有工作（0：无；1：有）
标签： 购房结果（0：否；1：是）

基尼指数计算公式
数据集里若有 \(K\) 个类别，\(p_k\) 表示第 \(k\) 类样本所占比例： \[ Gini(D) = 1 - \sum_{k=1}^{K} p_k^2 \]
加权基尼指数 特征 \(A\) 以取值 \(v\) 为切分点时，\(D\) 被分成 \(D_1(A=v)\) 与 \(D_2(A \neq v)\)： \[ Gini(D, A, v) = \frac{|D_1|}{|D|} \times Gini(D_1) + \frac{|D_2|}{|D|} \times Gini(D_2) \]
预测规则
叶子节点输出该节点中人数最多的类别；若两个类别人数相同，输出编号较小的类别。
停止分裂条件
下面任一条件成立，节点即停止分裂：
节点内全部样本的标签相同
节点内的样本数小于 2
不存在使基尼指数降低的切分点

平局处理规则
按特征编号从小到大遍历（特征1 → 特征2 → 特征3 → 特征4）
对当前特征，按取值从小到大遍历全部可能切分点
计算各切分点的加权基尼指数，保留其中最小的切分
若若干特征的加权基尼指数同为最小，取编号较小的特征
若同一特征上若干取值的加权基尼指数同为最小，取较小取值作为切分点（左子集是该特征等于这个较小值的样本）

解答要求
时间限制：C/C++ 1000ms，其他语言 2000ms
内存限制：C/C++ 512MB，其他语言 1024MB

输入
第一行给出整数 \(N\)，表示训练集的客户人数（\(4 \le N \le 20\)）。 随后 \(N\) 行，每行 5 个整数，依次是 4 个特征和 1 个标签，整数之间以空格分隔。 第 \(N+2\) 行给出整数 \(M\)，表示待预测的样本人数（\(1 \le M \le 10\)）。 随后 \(M\) 行，每行 4 个整数，依次是 4 个特征，整数之间以空格分隔。
输出
输出一行，共 \(M\) 个整数，依次为 \(M\) 个测试样本在所建 CART 树上的预测结果，整数之间以空格分隔。
样例1
输入：
8
0 0 0 0 0
1 1 0 1 0
2 2 0 0 0
3 1 0 1 0
0 1 1 0 1
1 2 1 1 1
2 0 1 0 1
3 2 1 1 1
4
2 1 0 1
0 2 1 0
3 0 0 0
1 1 1 1
输出：
0 1 0 1
解释：
根节点共 8 名客户，标签 0（否）与标签 1（是）各 4 人，所以 \[ Gini(D) = 1 - (4/8)^2 - (4/8)^2 = 0.5 \]

选取加权基尼指数最小的切分。特征3（是否有房）取切分点 0 时，左子集 4 人标签全为 0，右子集 4 人标签全为 1，加权基尼指数为 0。取切分点 1 只是左右对调，加权基尼指数同样为 0。二者并列，按平局规则保留较小取值 0，左子集为「是否有房 = 0」。 其余切分的加权基尼指数都大于 0。例如特征2（婚姻状况）取切分点 1 时，左子集 3 人里有 2 个 0、1 个 1，右子集 5 人里有 2 个 0、3 个 1，加权基尼指数为 \(7/15\)；特征4（是否有工作）取 0 或 1 时，两侧都是 2 个 0 与 2 个 1，加权基尼指数为 \(1/2\)。

左右子集的标签都已相同，停止分裂。左叶子预测 0，右叶子预测 1。

四个测试样本的特征3依次为 0、1、0、1。等于切分点的进入左子树，不等于的进入右子树，预测为 0 1 0 1。

解法　递归建树。每个节点按特征 1 到 4、取值从小到大，枚举“等于 $v$ / 不等于 $v$”的二分，算加权基尼指数，只有严格更小才替换当前最优，这样就自动满足平局规则。满足停止条件时生成叶子，输出多数类，人数相同输出 0。预测时特征值等于切分点走左子树。$N\le 20$，暴力枚举足够。

易错点　第三个停止条件要求加权基尼严格低于当前节点的基尼指数；“不等于”一侧为空的切分没有意义，直接跳过；年龄段、婚姻状况不是二值特征，同一特征在子树里可以再次被选中；浮点比较留一点容差。

### 原始参考答案

```python
import sys


def gini(rows):
    if not rows:
        return 0.0
    p = sum(r[4] for r in rows) / len(rows)
    return 1 - p * p - (1 - p) * (1 - p)


def majority(rows):
    ones = sum(r[4] for r in rows)
    return 1 if ones > len(rows) - ones else 0      # 人数相同取编号小的 0


def build(rows):
    labels = {r[4] for r in rows}
    if len(labels) <= 1 or len(rows) < 2:
        return ('leaf', majority(rows))
    base = gini(rows)
    best = None                                       # (加权基尼, 特征, 切分值)
    for f in range(4):                                # 特征从小到大
        for v in sorted({r[f] for r in rows}):        # 取值从小到大
            left = [r for r in rows if r[f] == v]
            right = [r for r in rows if r[f] != v]
            if not right:
                continue
            g = (len(left) * gini(left) + len(right) * gini(right)) / len(rows)
            if best is None or g < best[0] - 1e-12:   # 严格更小才替换，平局保留先遇到的
                best = (g, f, v)
    if best is None or best[0] >= base - 1e-12:       # 没有能降低基尼指数的切分
        return ('leaf', majority(rows))
    _, f, v = best
    return ('node', f, v,
            build([r for r in rows if r[f] == v]),
            build([r for r in rows if r[f] != v]))


def predict(tree, x):
    while tree[0] == 'node':
        _, f, v, left, right = tree
        tree = left if x[f] == v else right
    return tree[1]


def main():
    data = list(map(int, sys.stdin.read().split()))
    n = data[0]
    rows = [data[1 + 5 * i: 6 + 5 * i] for i in range(n)]
    pos = 1 + 5 * n
    m = data[pos]
    tests = [data[pos + 1 + 4 * i: pos + 5 + 4 * i] for i in range(m)]
    tree = build(rows)
    print(' '.join(str(predict(tree, x)) for x in tests))


main()
```
