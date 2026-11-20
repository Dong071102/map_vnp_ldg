// Visual sovereignty overlay for Vietnam's Hoang Sa & Truong Sa archipelagos
// Purely visual map layer (independent from Lam Dong DB regions & GeoJSON exports)

const VN_ARCHIPELAGOS = [
  {
    id: 'hoang-sa',
    name: 'Quần đảo Hoàng Sa',
    subtitle: 'Chủ quyền Việt Nam',
    adminNote: 'Trực thuộc TP. Đà Nẵng, Việt Nam',
    center: [16.52, 112.02],
    // Geographic extent ~ 15°45'N–17°15'N, 111°00'E–113°00'E
    polygon: [
      [17.25, 111.0],
      [17.25, 113.0],
      [15.75, 113.0],
      [15.75, 111.0],
    ],
  },
  {
    id: 'truong-sa',
    name: 'Quần đảo Trường Sa',
    subtitle: 'Chủ quyền Việt Nam',
    adminNote: 'Trực thuộc tỉnh Khánh Hòa, Việt Nam',
    center: [9.85, 114.25],
    // Geographic extent ~ 6°30'N–12°00'N, 111°30'E–117°20'E
    polygon: [
      [12.0, 111.5],
      [12.0, 117.3],
      [6.5, 117.3],
      [6.5, 111.5],
    ],
  },
];

const VN_STAR_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="#ffcd00" aria-hidden="true">
  <polygon points="12,2 14.9,8.6 22,9.3 16.6,14 18.2,21 12,17.3 5.8,21 7.4,14 2,9.3 9.1,8.6"/>
</svg>`;

export function addVietnamIslandsOverlay(map) {
  if (!map) return null;

  if (!map.getPane('vnSovereigntyPane')) {
    const pane = map.createPane('vnSovereigntyPane');
    pane.style.zIndex = '340';
  }
  if (!map.getPane('vnSovereigntyLabelPane')) {
    const pane = map.createPane('vnSovereigntyLabelPane');
    pane.style.zIndex = '620';
  }

  const group = L.layerGroup().addTo(map);

  for (const item of VN_ARCHIPELAGOS) {
    const popupHtml = `<div class="ward-info-card">
      <div class="ward-info-title" style="color:#b91c1c">★ ${item.name} (Việt Nam)</div>
      <div>- ${item.subtitle}</div>
      <div>- ${item.adminNote}</div>
    </div>`;

    L.polygon(item.polygon, {
      pane: 'vnSovereigntyPane',
      color: '#da251d',
      weight: 2,
      dashArray: '8, 6',
      opacity: 0.9,
      fillColor: '#da251d',
      fillOpacity: 0.08,
      interactive: true,
    })
      .bindPopup(popupHtml, { className: 'ward-click-popup' })
      .addTo(group);

    L.marker(item.center, {
      pane: 'vnSovereigntyLabelPane',
      icon: L.divIcon({
        className: 'vn-sovereignty-marker',
        html: `<div class="vn-sovereignty-badge">
          <span class="vn-star-ico">${VN_STAR_SVG}</span>
          <span>${item.name} (Việt Nam)</span>
        </div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
    })
      .bindPopup(popupHtml, { className: 'ward-click-popup' })
      .addTo(group);
  }

  return group;
}
