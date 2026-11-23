import {
  fetchLamDongUnits,
  syncLamDongList,
  updateLamDongUnitLink,
  updateLamDongUnitFields,
  fetchAndSaveLamDongGeojson,
  importLamDongOpenData,
} from './api.js?v=20261123b';
import { notify, confirmNoti } from './notify.js?v=20261123b';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function initAdminTab({ onDbUpdate, onOpenRegionOnMap, onOpenAllSavedOnMap, canEdit = () => true }) {
  const $ = (id) => document.getElementById(id);

  const searchInput = $('adminSearchInput');
  const typeFilter = $('adminTypeFilter');
  const oldDistrictFilter = $('adminOldDistrictFilter');
  const statusFilter = $('adminStatusFilter');
  const sourceSelect = $('adminSourceSelect');
  const importOpenDataBtn = $('adminImportOpenDataBtn');
  const syncWikiBtn = $('adminSyncWikiBtn');
  const batchFetchBtn = $('adminBatchFetchBtn');
  const stopBatchBtn = $('adminStopBatchBtn');
  const openMapAllBtn = $('adminOpenMapAllBtn');
  const toggleAdvancedBtn = $('adminToggleAdvancedBtn');
  const advancedPanel = $('adminAdvancedPanel');
  const selectAllCb = $('adminSelectAllCb');

  const statTotal = $('adminStatTotal');
  const statSynced = $('adminStatSynced');
  const statPending = $('adminStatPending');
  const statError = $('adminStatError');
  const progressWrap = $('adminProgressWrap');
  const progressBar = $('adminProgressBar');
  const progressText = $('adminProgressText');
  const tbody = $('adminTableBody');

  let units = [];
  let selectedIds = new Set();
  let editingOdId = null; // currently open inline old-district editor
  let expandedLinkId = null; // currently open inline link/refetch drawer row
  let isBatchRunning = false;
  let cancelBatch = false;
  let loadedOnce = false;

  function populateOldDistrictFilter() {
    if (!oldDistrictFilter) return;
    const prev = oldDistrictFilter.value || 'all';
    const names = new Set();
    for (const u of units) {
      if (!u.oldDistrict) continue;
      for (const part of u.oldDistrict.split(',')) {
        const clean = part.trim();
        if (clean) names.add(clean);
      }
    }
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'vi'));
    oldDistrictFilter.innerHTML =
      '<option value="all">Tất cả huyện cũ</option>' +
      sorted.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    if (sorted.includes(prev)) oldDistrictFilter.value = prev;
  }

  function getFilteredUnits() {
    const q = searchInput.value.trim().toLowerCase();
    const t = typeFilter.value;
    const od = oldDistrictFilter?.value || 'all';
    const s = statusFilter.value;

    return units.filter((u) => {
      if (t !== 'all' && u.unitType !== t) return false;
      if (od !== 'all' && !String(u.oldDistrict || '').includes(od)) return false;
      if (s === 'synced' && !u.hasGeojson) return false;
      if (s === 'pending' && (u.hasGeojson || u.syncStatus === 'error')) return false;
      if (s === 'error' && u.syncStatus !== 'error') return false;
      if (q) {
        const hay = `${u.stt} ${u.name} ${u.oldDistrict || ''} ${u.oldProvince || ''} ${u.wikiUrl} ${u.subUnits} ${u.region?.qid || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function updateSummary() {
    const total = units.length;
    const synced = units.filter((u) => u.hasGeojson).length;
    const errCount = units.filter((u) => !u.hasGeojson && u.syncStatus === 'error').length;
    const pending = total - synced - errCount;

    statTotal.textContent = String(total);
    statSynced.textContent = `${synced}/${total} có bản đồ`;
    statPending.textContent = `${pending} chưa có`;
    statPending.hidden = pending === 0;
    statError.textContent = `${errCount} lỗi`;
    statError.hidden = errCount === 0;

    const selCount = selectedIds.size;
    batchFetchBtn.textContent =
      selCount > 0 ? `⬇ Lấy & Lưu GeoJSON (${selCount} dòng chọn)` : `⬇ Lấy & Lưu chưa có (${pending + errCount})`;
    batchFetchBtn.disabled = isBatchRunning || (selCount === 0 && pending + errCount === 0);
  }

  function showProgress(text, pct = null) {
    progressWrap.hidden = false;
    progressText.textContent = text;
    if (pct !== null) {
      progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }
  }

  function hideProgress() {
    progressWrap.hidden = true;
    progressBar.style.width = '0%';
    progressText.textContent = '';
  }

  function renderTable() {
    const filtered = getFilteredUnits();
    updateSummary();

    selectAllCb.checked = filtered.length > 0 && filtered.every((u) => selectedIds.has(u.id));

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="admin-empty-cell">Không tìm thấy đơn vị hành chính nào phù hợp.</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    filtered.forEach((u) => {
      const tr = document.createElement('tr');
      tr.dataset.unitId = String(u.id);
      if (u.syncStatus === 'error' && !u.hasGeojson) tr.className = 'row-error';

      const typeClass =
        u.unitType === 'Phường' ? 'type-phuong' : u.unitType === 'Đặc khu' ? 'type-dackhu' : 'type-xa';

      let statusHtml = '<span class="clean-status pending">Chưa có</span>';
      if (u.hasGeojson) {
        const areaPart = u.region?.areaKm2 ? `${u.region.areaKm2.toFixed(1)} km²` : 'Đã lưu';
        const modBadge = u.region?.modified ? ' · <span class="edited-tag">Đã sửa</span>' : '';
        statusHtml = `<span class="clean-status ok" title="Nguồn: ${escapeHtml(u.region?.source || '')} · ${u.region?.points || 0} điểm">${areaPart}${modBadge}</span>`;
      } else if (u.syncStatus === 'error') {
        statusHtml = `<span class="clean-status err" title="${escapeHtml(u.syncError || 'Lỗi')}">Lỗi ⚠</span>`;
      }

      const editable = canEdit();
      const isEditingOd = editable && editingOdId === u.id;
      const oldDistrictCellHtml = isEditingOd
        ? `<div class="inline-edit-box">
             <input type="text" class="inline-edit-input od-edit-input" value="${escapeHtml(u.oldDistrict || '')}" placeholder="Tên huyện cũ..." />
             <button type="button" class="mini-btn highlight od-save-btn" title="Lưu (Enter)">✓</button>
             <button type="button" class="mini-btn od-cancel-btn" title="Hủy (Esc)">✕</button>
           </div>`
        : `<div class="${editable ? 'editable-text-cell od-trigger' : 'old-district-readonly'}"${editable ? ' title="Bấm để sửa huyện cũ"' : ''}>
             <span class="old-district-name">${escapeHtml(u.oldDistrict || '—')}</span>
             ${editable ? '<button type="button" class="inline-pencil-btn" aria-label="Sửa huyện cũ">✎</button>' : ''}
           </div>
           ${u.oldProvince ? `<div class="sub-metric">${escapeHtml(u.oldProvince)}</div>` : ''}`;

      tr.innerHTML = `
        <td class="col-cb"><input type="checkbox" class="row-cb" ${selectedIds.has(u.id) ? 'checked' : ''} /></td>
        <td class="col-stt">${u.stt}</td>
        <td class="col-name">
          <div class="unit-name-line">
            <span class="unit-type-badge ${typeClass}">${escapeHtml(u.unitType)}</span>
            <strong>${escapeHtml(u.name.replace(/^(Phường|Xã|Đặc khu)\s+/i, ''))}</strong>
          </div>
          ${
            u.subUnits
              ? `<details class="sub-units-details"><summary>Thôn / tổ dân phố</summary><p>${escapeHtml(u.subUnits)}</p></details>`
              : ''
          }
        </td>
        <td class="col-old-district">${oldDistrictCellHtml}</td>
        <td class="col-metrics num-col">
          <div>${u.areaOfficialKm2.toLocaleString('vi-VN', { maximumFractionDigits: 2 })} km²</div>
          <div class="sub-metric">${u.population2025.toLocaleString('vi-VN')} dân</div>
        </td>
        <td class="col-status">${statusHtml}</td>
        <td class="col-actions right-col">
          <div class="row-action-btns right-actions">
            <button type="button" class="btn small primary view-map-btn" title="${editable ? 'Mở bản đồ &amp; chỉnh sửa ranh giới' : 'Xem bản đồ ranh giới'}">
              ${editable ? 'Sửa bản đồ' : 'Xem bản đồ'}
            </button>
            ${
              editable
                ? `<button type="button" class="btn small ghost-btn toggle-link-row-btn${expandedLinkId === u.id ? ' active-link-btn' : ''}" title="Sửa link nguồn / cập nhật lại GeoJSON">🔗</button>`
                : ''
            }
          </div>
        </td>
      `;

      const rowCb = tr.querySelector('.row-cb');
      rowCb.addEventListener('change', () => {
        if (rowCb.checked) selectedIds.add(u.id);
        else selectedIds.delete(u.id);
        updateSummary();
      });

      if (isEditingOd) {
        const odInput = tr.querySelector('.od-edit-input');
        const odSaveBtn = tr.querySelector('.od-save-btn');
        const odCancelBtn = tr.querySelector('.od-cancel-btn');
        setTimeout(() => {
          odInput?.focus();
          odInput?.select();
        }, 0);

        const commitOd = async () => {
          const newOd = odInput.value.trim();
          odSaveBtn.disabled = true;
          try {
            const res = await updateLamDongUnitFields(u.id, { oldDistrict: newOd });
            replaceUnit(res.unit);
            editingOdId = null;
            populateOldDistrictFilter();
            renderTable();
            showProgress(`Đã cập nhật huyện cũ "${newOd || '—'}" cho ${u.name}.`, 100);
          } catch (err) {
            showProgress(`Lỗi lưu huyện cũ (${u.name}): ${err.message}`, 0);
            odSaveBtn.disabled = false;
          }
        };

        odSaveBtn.addEventListener('click', commitOd);
        odCancelBtn.addEventListener('click', () => {
          editingOdId = null;
          renderTable();
        });
        odInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitOd();
          } else if (e.key === 'Escape') {
            editingOdId = null;
            renderTable();
          }
        });
      } else {
        tr.querySelector('.od-trigger')?.addEventListener('click', () => {
          editingOdId = u.id;
          renderTable();
        });
      }

      tr.querySelector('.view-map-btn').addEventListener('click', () => {
        onOpenRegionOnMap?.(u);
      });

      tr.querySelector('.toggle-link-row-btn')?.addEventListener('click', () => {
        expandedLinkId = expandedLinkId === u.id ? null : u.id;
        renderTable();
      });

      fragment.appendChild(tr);

      // Optional clean expandable sub-row for editing source link or refetching from link
      if (editable && expandedLinkId === u.id) {
        const subTr = document.createElement('tr');
        subTr.className = 'link-expand-row';
        subTr.innerHTML = `
          <td colspan="7">
            <div class="link-expand-inner">
              <span class="link-expand-label">Link GeoJSON:</span>
              <input type="text" class="link-input" value="${escapeHtml(u.wikiUrl || '')}" placeholder="Dán link GeoJSON hoặc Wikipedia..." />
              <button type="button" class="btn small save-link-btn">💾 Lưu link</button>
              <button type="button" class="btn small primary fetch-one-btn" ${isBatchRunning ? 'disabled' : ''}>↻ Lấy lại từ link</button>
              <a class="btn small ghost-btn" href="${escapeHtml(u.wikiUrl || '#')}" target="_blank" rel="noopener">Mở ↗</a>
              <button type="button" class="mini-btn close-expand-btn" title="Đóng">✕</button>
            </div>
          </td>
        `;

        const linkInput = subTr.querySelector('.link-input');
        const saveLinkBtn = subTr.querySelector('.save-link-btn');
        const fetchOneBtn = subTr.querySelector('.fetch-one-btn');
        const openLinkA = subTr.querySelector('a');

        linkInput.addEventListener('input', () => {
          openLinkA.href = linkInput.value.trim() || '#';
        });

        linkInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            saveLinkBtn.click();
          } else if (e.key === 'Escape') {
            expandedLinkId = null;
            renderTable();
          }
        });

        saveLinkBtn.addEventListener('click', async () => {
          const newUrl = linkInput.value.trim();
          saveLinkBtn.disabled = true;
          try {
            const res = await updateLamDongUnitLink(u.id, newUrl);
            replaceUnit(res.unit);
            renderTable();
            showProgress(`Đã lưu link mới cho ${u.name}.`, 100);
          } catch (err) {
            showProgress(`Lỗi lưu link (${u.name}): ${err.message}`, 0);
          } finally {
            saveLinkBtn.disabled = false;
          }
        });

        fetchOneBtn.addEventListener('click', async () => {
          const targetUrl = linkInput.value.trim();
          fetchOneBtn.disabled = true;
          fetchOneBtn.textContent = 'Đang lấy...';
          showProgress(`Đang lấy GeoJSON cho #${u.stt} ${u.name}...`, 40);
          try {
            const res = await fetchAndSaveLamDongGeojson(u.id, {
              wikiUrl: targetUrl,
              source: sourceSelect.value,
            });
            if (res.db) onDbUpdate?.(res.db);
            replaceUnit(res.unit);
            renderTable();
            showProgress(`✓ Đã cập nhật GeoJSON cho ${u.name}.`, 100);
          } catch (err) {
            if (err.data?.unit) replaceUnit(err.data.unit);
            renderTable();
            showProgress(`⚠ ${u.name}: ${err.message}`, 0);
          }
        });

        subTr.querySelector('.close-expand-btn').addEventListener('click', () => {
          expandedLinkId = null;
          renderTable();
        });

        fragment.appendChild(subTr);
      }
    });

    tbody.innerHTML = '';
    tbody.appendChild(fragment);
  }

  function replaceUnit(updated) {
    if (!updated) return;
    const idx = units.findIndex((x) => x.id === updated.id);
    if (idx >= 0) units[idx] = updated;
  }

  async function loadUnits(force = false) {
    if (loadedOnce && !force) return;
    showProgress('Đang tải danh sách 124 ĐVHC Lâm Đồng...', 30);
    try {
      const res = await fetchLamDongUnits();
      if (res.db) onDbUpdate?.(res.db);
      units = res.units || [];
      loadedOnce = true;
      populateOldDistrictFilter();
      renderTable();
      hideProgress();
    } catch (err) {
      if (err.data?.db) onDbUpdate?.(err.data.db);
      showProgress(`Lỗi tải danh sách từ SQL Server: ${err.message}`, 0);
    }
  }

  async function runBatchFetch() {
    if (isBatchRunning) return;
    const targets =
      selectedIds.size > 0
        ? units.filter((u) => selectedIds.has(u.id))
        : units.filter((u) => !u.hasGeojson);

    if (targets.length === 0) return;

    isBatchRunning = true;
    cancelBatch = false;
    stopBatchBtn.hidden = false;
    syncWikiBtn.disabled = true;
    renderTable();

    let okCount = 0;
    let errCount = 0;

    for (let i = 0; i < targets.length; i++) {
      if (cancelBatch) break;
      const u = targets[i];
      const pct = Math.round(((i + 0.2) / targets.length) * 100);
      showProgress(`Đang lấy [${i + 1}/${targets.length}] #${u.stt} ${u.name}... (Thành công: ${okCount}, Lỗi: ${errCount})`, pct);

      try {
        const res = await fetchAndSaveLamDongGeojson(u.id, {
          wikiUrl: u.wikiUrl,
          source: sourceSelect.value,
        });
        if (res.db) onDbUpdate?.(res.db);
        replaceUnit(res.unit);
        okCount++;
      } catch (err) {
        if (err.data?.unit) replaceUnit(err.data.unit);
        errCount++;
      }
      renderTable();
      await new Promise((r) => setTimeout(r, 250));
    }

    isBatchRunning = false;
    stopBatchBtn.hidden = true;
    syncWikiBtn.disabled = false;
    renderTable();

    const suffix = cancelBatch ? ' (đã dừng)' : '';
    showProgress(`Hoàn tất${suffix}: lưu thành công ${okCount}/${targets.length}, lỗi ${errCount}.`, 100);
  }

  searchInput.addEventListener('input', renderTable);
  typeFilter.addEventListener('change', renderTable);
  oldDistrictFilter?.addEventListener('change', renderTable);
  statusFilter.addEventListener('change', renderTable);

  selectAllCb.addEventListener('change', () => {
    const filtered = getFilteredUnits();
    if (selectAllCb.checked) {
      filtered.forEach((u) => selectedIds.add(u.id));
    } else {
      filtered.forEach((u) => selectedIds.delete(u.id));
    }
    renderTable();
  });

  toggleAdvancedBtn?.addEventListener('click', () => {
    if (!advancedPanel) return;
    const isHidden = advancedPanel.hidden;
    advancedPanel.hidden = !isHidden;
    toggleAdvancedBtn.setAttribute('aria-expanded', String(isHidden));
    toggleAdvancedBtn.textContent = isHidden ? '⚙ Nâng cao ▴' : '⚙ Nâng cao ▾';
    toggleAdvancedBtn.classList.toggle('active-ref', isHidden);
  });

  syncWikiBtn.addEventListener('click', async () => {
    const ok = await confirmNoti({
      title: 'Đồng bộ danh sách 124 ĐVHC',
      message: 'Xác nhận đồng bộ lại danh sách 124 ĐVHC từ Wikipedia / table.html?\nCác link GeoJSON bạn đã sửa vẫn được giữ nguyên.',
      tone: 'info',
      confirmText: 'Đồng ý',
      cancelText: 'Không',
    });
    if (!ok) return;
    syncWikiBtn.disabled = true;
    showProgress('Đang đồng bộ danh sách 124 ĐVHC...', 40);
    try {
      const res = await syncLamDongList({ source: 'wikipedia', overwriteLinks: false });
      if (res.db) onDbUpdate?.(res.db);
      units = res.units || [];
      loadedOnce = true;
      renderTable();
      showProgress(`Đã đồng bộ ${res.count} ĐVHC từ ${res.usedSource}.`, 100);
      notify(`Đã đồng bộ ${res.count} ĐVHC.`, { type: 'success' });
    } catch (err) {
      showProgress(`Lỗi đồng bộ danh sách: ${err.message}`, 0);
      notify(`Lỗi đồng bộ danh sách: ${err.message}`, { type: 'error' });
    } finally {
      syncWikiBtn.disabled = false;
    }
  });

  importOpenDataBtn?.addEventListener('click', async () => {
    const ok = await confirmNoti({
      title: 'Cảnh báo xóa & tạo mới toàn bộ GeoJSON',
      message:
        'Thao tác này sẽ XÓA TOÀN BỘ GeoJSON hiện có trong SQL Server (kể cả mọi ranh giới xã/huyện bạn đã chỉnh tay) và tạo mới lại bộ Open Data gồm 124 Xã/Phường 2025 + 30 Huyện/TP cũ.',
      tone: 'danger',
      confirmText: 'Đồng ý xóa & tạo mới',
      cancelText: 'Không',
    });
    if (!ok) return;
    importOpenDataBtn.disabled = true;
    showProgress('Đang xóa dữ liệu cũ và tạo mới 124 Xã + 30 Huyện cũ...', 45);
    try {
      const res = await importLamDongOpenData();
      if (res.db) onDbUpdate?.(res.db);
      units = res.units || [];
      loadedOnce = true;
      populateOldDistrictFilter();
      renderTable();
      showProgress(
        `✓ Hoàn tất! Đã tạo mới ${res.wardsCount} Xã/Phường 2025 + ${res.oldDistrictsCount} Huyện/TP cũ vào SQL Server.`,
        100,
      );
      notify(`Đã tạo mới ${res.wardsCount} Xã/Phường + ${res.oldDistrictsCount} Huyện cũ.`, { type: 'success' });
    } catch (err) {
      showProgress(`Lỗi tạo mới Open Data: ${err.message}`, 0);
    } finally {
      importOpenDataBtn.disabled = false;
    }
  });

  batchFetchBtn.addEventListener('click', runBatchFetch);
  stopBatchBtn.addEventListener('click', () => {
    cancelBatch = true;
    stopBatchBtn.disabled = true;
    setTimeout(() => (stopBatchBtn.disabled = false), 500);
  });

  openMapAllBtn.addEventListener('click', () => onOpenAllSavedOnMap?.());

  return {
    onActivate: () => loadUnits(true),
    getUnits: () => units,
    updateUnitRow: (updated) => {
      replaceUnit(updated);
      renderTable();
    },
  };
}
