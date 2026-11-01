import type { DesignConfig, LayoutGeometry } from './model';
import { pasteAssignment } from './materials';
import { useI18n } from './i18n';

export function MaterialDistribution({ config, geometry }: { config: DesignConfig; geometry: LayoutGeometry }) {
  const { t, locale } = useI18n(), report = pasteAssignment(config, geometry);
  return <section className="form-section paste-distribution" data-testid="paste-distribution">
    <h2>{t('Paste distribution')}</h2>
    <p>{t('pasteAlternation')}</p>
    <div className="paste-plate-totals">{report.plates.map((plate) => <div key={plate.plate} data-paste-plate={plate.plate}>
      <strong>{t(plate.role === 'bigger' ? 'reviewBigger' : 'reviewSmaller')}</strong>
      <span data-paste-area="18NR-T">18NR-T · TiO₂ {plate.areasMm2['18NR-T'].toFixed(2)} mm²</span>
      <span data-paste-area="PT-1">PT-1 · Pt {plate.areasMm2['PT-1'].toFixed(2)} mm²</span>
    </div>)}</div>
    <details open={geometry.cells.length <= 8}><summary>{t('pasteCellTable')}</summary>
      <table><thead><tr><th>Cell</th><th>{t('reviewBigger')}</th><th>{t('reviewSmaller')}</th><th>mm²</th></tr></thead>
        <tbody>{report.cells.map((cell) => <tr key={cell.cellNumber} data-paste-cell={cell.cellNumber} data-bigger-paste={cell.bigger} data-smaller-paste={cell.smaller}>
          <td>{cell.cellNumber}</td><td>{cell.bigger}</td><td>{cell.smaller}</td><td>{cell.activeAreaMm2.toFixed(2)}</td>
        </tr>)}</tbody></table>
    </details>
    <small>{locale === 'zh-TW' ? '面積依實際塗層計算，留白／封膠／接觸條不會補上另一種漿料。材料代號不會自動改動電性或厚度假設。' : 'Areas use actual coating geometry. Blank/seal/contact areas are not filled with the other paste. Product codes do not change electrical or thickness assumptions.'}</small>
  </section>;
}
