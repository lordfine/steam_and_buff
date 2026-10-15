// Shared extension diagnostics: failures remain visible even in an empty shortlist.
function renderReviewStatus(items) {
  const counts = { fresh: 0, stale: 0, error: 0, partial: 0, pending: 0, unsupported: 0 };
  for (const item of items) counts[quoteStatus(item)]++;
  document.getElementById('quoteSummary').textContent = `已复核 ${counts.fresh} · 已过期 ${counts.stale} · 失败 ${counts.error} · 未完整复核 ${counts.partial + counts.pending + counts.unsupported}`;
  const failure = items.find(item => quoteStatus(item) === 'error');
  const notice = document.getElementById('quoteFailureNotice');
  notice.hidden = !failure;
  notice.textContent = failure ? `${failure.name}：${failure.steamEnrichError || failure.steamOrderbookError}` : '';
}
document.getElementById('btnNeedsReview').addEventListener('click', () => {
  document.getElementById('candidateFilter').checked = false;
  for (const id of ['searchInput', 'ratioFilter', 'maxLiquidityDays', 'maxPrice', 'maxPriceFilter']) {
    const input = document.getElementById(id); if (input) input.value = '';
  }
  for (const id of ['minPrice', 'minPriceFilter', 'minBuffSellNum', 'minSteamVolume']) {
    const input = document.getElementById(id); if (input) input.value = '0';
  }
  const game = document.getElementById('gameFilter'); if (game) game.value = 'all';
  applyAndSave();
});
