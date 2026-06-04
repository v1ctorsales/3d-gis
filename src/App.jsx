import { useRef, useState } from "react";
import MapView from "./components/Map/MapView";
import SelectionPanel from "./components/SelectionPanel/SelectionPanel";
import Viewer3D from "./components/Viewer3D/Viewer3D";
import { LanguageProvider, useLanguage } from "./contexts/LanguageContext";
import "./App.css";

function AppContent() {
  const [view, setView] = useState("select"); // 'select' | 'view3d'
  const [selection, setSelection] = useState(null);
  const [aoi, setAoi] = useState(null);
  const mapRef = useRef(null);
  const { lang, setLang, t } = useLanguage();

  const handleClear = () => {
    mapRef.current?.clearSelection();
    setSelection(null);
  };

  const handleConfirm = () => {
    if (!selection) return;
    setAoi(selection);
    setView("view3d");
  };

  const handleBack = () => {
    // The MapView remounts on the way back, so terra-draw state is
    // already reset. We clear the selection so the panel matches.
    setSelection(null);
    setView("select");
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <h1>{t.appTitle}</h1>
          <span className="app-byline">
            {t.developedBy}{" "}
            <a
              href="https://www.victorsales.com.br"
              target="_blank"
              rel="noopener noreferrer"
              className="app-byline-name"
            >
              Victor Sales
            </a>
          </span>
        </div>
        <div className="app-header-right">
          <button
            type="button"
            className={`lang-toggle${lang === "pt-BR" ? " lang-toggle--right" : ""}`}
            onClick={() => setLang(lang === "en" ? "pt-BR" : "en")}
            aria-label={
              lang === "en" ? "Mudar para Português" : "Switch to English"
            }
          >
            <span className="lang-toggle__thumb" />
            <span
              className={`lang-toggle__option${lang === "en" ? " lang-toggle__option--active" : ""}`}
            >
              <img src="/gb.svg" alt="EN" width="20" height="14" />
              EN-GB
            </span>
            <span
              className={`lang-toggle__option${lang === "pt-BR" ? " lang-toggle__option--active" : ""}`}
            >
              <img src="/br.svg" alt="EN" width="20" height="14" />
              PT-BR
            </span>
          </button>
        </div>
      </header>
      <main className="app-main">
        {view === "select" && (
          <>
            <MapView ref={mapRef} onSelectionChange={setSelection} />
            <SelectionPanel
              selection={selection}
              onClear={handleClear}
              onConfirm={handleConfirm}
            />
          </>
        )}
        {view === "view3d" && aoi && (
          <Viewer3D bbox={aoi} onBack={handleBack} />
        )}
      </main>
    </div>
  );
}

function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}

export default App;
