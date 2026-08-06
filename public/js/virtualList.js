/**
 * 可変高さ対応の仮想スクロール（FR-06）。
 * 3時間音声で2,000〜4,000セグメントになるため、DOMは可視範囲＋前後の余白だけ作る。
 *
 * 各要素の高さは描画後に実測して記録し、以降のオフセット計算に反映する。
 * 画面より上の要素の高さが変わったときは scrollTop を補正して、
 * 見ている位置が飛ばないようにする。
 */
export class VirtualList {
  constructor(scroller, { items = [], estimateHeight = 76, overscan = 8, renderItem, key }) {
    this.scroller = scroller;
    this.inner = document.createElement('div');
    this.inner.className = 'vlist-inner';
    this.scroller.append(this.inner);

    this.items = items;
    this.estimateHeight = estimateHeight;
    this.overscan = overscan;
    this.renderItem = renderItem;
    this.key = key || ((_, i) => i);

    this.heights = items.map(() => estimateHeight);
    this.offsets = [];
    this.dirty = true;
    this.nodes = new Map(); // index -> HTMLElement
    this.range = [0, -1];

    this.onScroll = () => this.schedule();
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(this.scroller);
    this.render();
  }

  setItems(items, { preserveScroll = true } = {}) {
    const top = this.scroller.scrollTop;
    const previous = new Map(this.items.map((item, i) => [this.key(item, i), this.heights[i]]));
    this.items = items;
    this.heights = items.map((item, i) => previous.get(this.key(item, i)) ?? this.estimateHeight);
    this.dirty = true;
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.range = [0, -1];
    this.render();
    if (preserveScroll) this.scroller.scrollTop = Math.min(top, this.totalHeight());
  }

  computeOffsets() {
    if (!this.dirty) return;
    this.offsets = new Array(this.heights.length + 1);
    this.offsets[0] = 0;
    for (let i = 0; i < this.heights.length; i += 1) {
      this.offsets[i + 1] = this.offsets[i] + this.heights[i];
    }
    this.dirty = false;
  }

  totalHeight() {
    this.computeOffsets();
    return this.offsets[this.offsets.length - 1] || 0;
  }

  indexAt(y) {
    this.computeOffsets();
    let lo = 0;
    let hi = this.items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  render() {
    if (!this.items.length) {
      this.inner.style.height = '0px';
      for (const node of this.nodes.values()) node.remove();
      this.nodes.clear();
      return;
    }
    this.computeOffsets();
    this.inner.style.height = `${this.totalHeight()}px`;

    const viewTop = this.scroller.scrollTop;
    const viewBottom = viewTop + this.scroller.clientHeight;
    const start = Math.max(0, this.indexAt(viewTop) - this.overscan);
    let end = this.indexAt(viewBottom);
    while (end < this.items.length - 1 && this.offsets[end + 1] < viewBottom) end += 1;
    end = Math.min(this.items.length - 1, end + this.overscan);

    // 範囲外のノードを外す。編集中（フォーカスを持つ）のノードは残す。
    for (const [index, node] of this.nodes) {
      if ((index < start || index > end) && !node.contains(document.activeElement)) {
        node.remove();
        this.nodes.delete(index);
      }
    }

    for (let i = start; i <= end; i += 1) {
      if (this.nodes.has(i)) continue;
      const node = this.renderItem(this.items[i], i);
      node.style.position = 'absolute';
      node.dataset.index = String(i);
      this.inner.append(node);
      this.nodes.set(i, node);
    }

    this.position();
    // レイアウト確定後に実測して高さを補正する
    requestAnimationFrame(() => this.measure(viewTop, start));
    this.range = [start, end];
  }

  position() {
    this.computeOffsets();
    for (const [index, node] of this.nodes) {
      node.style.top = `${this.offsets[index]}px`;
    }
  }

  measure(previousScrollTop, start) {
    let delta = 0;
    let changed = false;
    for (const [index, node] of this.nodes) {
      const height = node.offsetHeight;
      if (height > 0 && Math.abs(height - this.heights[index]) > 0.5) {
        if (index < start) delta += height - this.heights[index];
        this.heights[index] = height;
        changed = true;
      }
    }
    if (!changed) return;
    this.dirty = true;
    this.inner.style.height = `${this.totalHeight()}px`;
    this.position();
    if (delta !== 0) this.scroller.scrollTop = previousScrollTop + delta;
  }

  /** 指定インデックスへスクロールする（検索ヒット・再生位置追従で使用）。 */
  scrollToIndex(index, { align = 'center', behavior = 'smooth' } = {}) {
    if (index < 0 || index >= this.items.length) return;
    this.computeOffsets();
    const top = this.offsets[index];
    const offset = align === 'center'
      ? Math.max(0, top - this.scroller.clientHeight / 2 + this.heights[index] / 2)
      : Math.max(0, top - 24);
    this.scroller.scrollTo({ top: offset, behavior });
  }

  /** 表示中のノードだけ更新する（ハイライトや話者名の反映）。 */
  updateVisible(fn) {
    for (const [index, node] of this.nodes) fn(node, this.items[index], index);
  }

  isVisible(index) {
    return index >= this.range[0] && index <= this.range[1];
  }

  destroy() {
    this.scroller.removeEventListener('scroll', this.onScroll);
    this.resizeObserver.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.inner.remove();
  }
}
