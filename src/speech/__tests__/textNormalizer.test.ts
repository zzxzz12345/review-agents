import { describe, expect, it } from 'vitest';
import { normalizeTextForTts } from '../textNormalizer';

describe('normalizeTextForTts', () => {
  it('converts snake_case, dunder names, kebab-case, API paths, and arrows into natural speech text', () => {
    expect(
      normalizeTextForTts('我们新增了 `kronos_relaxed_sigma_stop` 和 kronos_or2_ppd_sigma_stop_svm。')
    ).toBe('我们新增了 kronos relaxed sigma stop 和 kronos or2 ppd sigma stop svm。');

    expect(normalizeTextForTts('查看 __init__ 和 _helper 方法')).toBe(
      '查看 init 和 helper 方法'
    );

    expect(
      normalizeTextForTts('只读接口 /fork/source-state 挂载在 live-trading 上。')
    ).toBe('只读接口 fork source state 挂载在 live trading 上。');

    expect(normalizeTextForTts('数据流向 Gateway -> AuthService::Verify')).toBe(
      '数据流向 Gateway 到 AuthService Verify'
    );
  });

  it('preserves numeric fractions and line ranges', () => {
    expect(normalizeTextForTts('第 2/5 章查看第 10-25 行')).toBe(
      '第 2/5 章查看第 10-25 行'
    );
  });
});
