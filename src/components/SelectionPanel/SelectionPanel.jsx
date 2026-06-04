import { computeAreaKm2, MAX_AREA_KM2 } from "../../utils/geo";
import { useLanguage } from "../../contexts/LanguageContext";
import styles from "./SelectionPanel.module.css";

export default function SelectionPanel({ selection, onClear, onConfirm }) {
  const { t } = useLanguage();
  const areaKm2 = selection ? computeAreaKm2(selection) : 0;
  const overLimit = areaKm2 > MAX_AREA_KM2;

  return (
    <aside className={styles.panel}>
      <h2 className={styles.title}>{t.selectionTitle}</h2>

      {selection ? (
        <>
          <dl className={styles.coords}>
            <dt>{t.coordWest}</dt>
            <dd>{selection.west.toFixed(5)}</dd>
            <dt>{t.coordSouth}</dt>
            <dd>{selection.south.toFixed(5)}</dd>
            <dt>{t.coordEast}</dt>
            <dd>{selection.east.toFixed(5)}</dd>
            <dt>{t.coordNorth}</dt>
            <dd>{selection.north.toFixed(5)}</dd>
            <dt>{t.coordArea}</dt>
            <dd className={overLimit ? styles.areaOver : undefined}>
              {areaKm2.toFixed(2)} km² / {MAX_AREA_KM2} km²
            </dd>
          </dl>

          {overLimit && (
            <p className={styles.warning} role="alert">
              {t.selectionOverLimit(MAX_AREA_KM2)}
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={onConfirm}
              disabled={overLimit}
              aria-disabled={overLimit}
            >
              {t.confirmSelection}
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={onClear}
            >
              {t.clear}
            </button>
          </div>
        </>
      ) : (
        <p className={styles.hint}>{t.selectionHint}</p>
      )}
    </aside>
  );
}
