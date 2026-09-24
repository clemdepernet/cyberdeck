import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, MainMenu, WelcomeScreen, getSceneVersion, CaptureUpdateAction } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { listBoards, getBoard, createBoard, updateBoard, deleteBoard } from './api.js';

const AUTOSAVE_MS = 1500;
const lang = (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr-FR' : 'en';

// Only the bits of appState worth persisting: everything else is per-session UI.
function pickAppState(s) {
  return {
    viewBackgroundColor: s.viewBackgroundColor,
    gridModeEnabled: s.gridModeEnabled,
    gridSize: s.gridSize,
  };
}

function usedFiles(elements, files) {
  const out = {};
  for (const el of elements) if (el.type === 'image' && el.fileId && files[el.fileId]) out[el.fileId] = files[el.fileId];
  return out;
}

function timeLabel(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(lang === 'fr-FR' ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="deck-crash">
        <h2>{lang === 'fr-FR' ? 'Le whiteboard a planté.' : 'The whiteboard crashed.'}</h2>
        <p className="mono">{String(this.state.error && this.state.error.message)}</p>
        <button className="deck-btn" onClick={() => location.reload()}>{lang === 'fr-FR' ? 'Recharger' : 'Reload'}</button>
      </div>
    );
  }
}

export default function App() { return <Boundary><Board /></Boundary>; }

function Board() {
  const [api, setApi] = useState(null);
  const [boards, setBoards] = useState([]);
  const [current, setCurrent] = useState(null); // {id, name, updatedAt}
  const [name, setName] = useState('');
  const [status, setStatus] = useState({ kind: 'idle', text: '' });
  const [initialData, setInitialData] = useState(null);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('deck.wb.theme') || 'dark'; } catch { return 'dark'; } });
  const versionRef = useRef(0);   // scene version at last save
  const seenRef = useRef(0);      // scene version at last onChange we handled
  const timerRef = useRef(null);
  const currentRef = useRef(null);
  currentRef.current = current;

  const refresh = useCallback(async () => {
    try { setBoards(await listBoards()); } catch (e) { setStatus({ kind: 'error', text: e.message }); }
  }, []);

  // Boot: pick the board from ?board=, else the most recent one, else a blank canvas.
  useEffect(() => {
    (async () => {
      let list = [];
      try { list = await listBoards(); } catch (e) { setStatus({ kind: 'error', text: 'API injoignable : ' + e.message }); }
      setBoards(list);
      const wanted = new URLSearchParams(location.search).get('board');
      const pick = list.find((b) => b.id === wanted) || list[0];
      if (pick) {
        try {
          const b = await getBoard(pick.id);
          setCurrent({ id: b.id, name: b.name, updatedAt: b.updatedAt });
          setName(b.name);
          versionRef.current = seenRef.current = getSceneVersion(b.elements || []);
          setInitialData({ elements: b.elements || [], appState: { ...(b.appState || {}) }, files: b.files || {}, scrollToContent: true });
          return;
        } catch { /* fall through to blank */ }
      }
      setInitialData({ appState: {} });
      setName('');
    })();
  }, []);

  const save = useCallback(async (opts = {}) => {
    if (!api) return;
    const elements = api.getSceneElements();
    const appState = pickAppState(api.getAppState());
    const files = usedFiles(elements, api.getFiles());
    const cur = currentRef.current;
    const boardName = (opts.name ?? name ?? '').trim() || (lang === 'fr-FR' ? 'Sans titre' : 'Untitled');
    if (!cur && elements.length === 0 && !opts.force) return; // nothing worth a file yet
    setStatus({ kind: 'saving', text: lang === 'fr-FR' ? 'Enregistrement…' : 'Saving…' });
    try {
      let meta;
      if (cur) meta = await updateBoard(cur.id, { name: boardName, elements, appState, files });
      else {
        meta = await createBoard({ name: boardName, elements, appState, files });
        history.replaceState(null, '', `?board=${meta.id}`);
      }
      setCurrent(meta);
      if (!name) setName(meta.name);
      versionRef.current = getSceneVersion(elements);
      setStatus({ kind: 'saved', text: (lang === 'fr-FR' ? 'Enregistré à ' : 'Saved at ') + timeLabel(meta.updatedAt) });
      refresh();
    } catch (e) {
      setStatus({ kind: 'error', text: (lang === 'fr-FR' ? 'Échec : ' : 'Failed: ') + e.message });
    }
  }, [api, name, refresh]);

  const scheduleSave = useCallback((delay = AUTOSAVE_MS) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(), delay);
  }, [save]);

  // Excalidraw calls onChange on every internal update, including the re-render our
  // own setState triggers. Only react when the scene actually moved since the last
  // event we saw (not since the last save), otherwise React loops until error #185.
  const onChange = useCallback((elements, appState) => {
    if (appState.theme !== theme) { setTheme(appState.theme); try { localStorage.setItem('deck.wb.theme', appState.theme); } catch {} }
    const v = getSceneVersion(elements);
    if (v === seenRef.current) return;
    seenRef.current = v;
    if (v === versionRef.current) return; // back to the saved state (undo)
    setStatus((s) => (s.kind === 'dirty' ? s : { kind: 'dirty', text: lang === 'fr-FR' ? 'Modifications non enregistrées' : 'Unsaved changes' }));
    scheduleSave();
  }, [scheduleSave, theme]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); clearTimeout(timerRef.current); save({ force: true }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const loadBoard = useCallback(async (id) => {
    if (!api) return;
    clearTimeout(timerRef.current);
    if (status.kind === 'dirty') await save();
    try {
      const b = await getBoard(id);
      api.updateScene({ elements: b.elements || [], appState: { ...pickAppState(api.getAppState()), ...(b.appState || {}) }, captureUpdate: CaptureUpdateAction.NEVER });
      if (b.files && Object.keys(b.files).length) api.addFiles(Object.values(b.files));
      api.history.clear();
      api.scrollToContent(undefined, { fitToContent: true });
      versionRef.current = seenRef.current = getSceneVersion(b.elements || []);
      setCurrent({ id: b.id, name: b.name, updatedAt: b.updatedAt });
      setName(b.name);
      setStatus({ kind: 'saved', text: (lang === 'fr-FR' ? 'Ouvert · enregistré à ' : 'Opened · saved at ') + timeLabel(b.updatedAt) });
      history.replaceState(null, '', `?board=${b.id}`);
    } catch (e) {
      setStatus({ kind: 'error', text: e.message });
    }
  }, [api, save, status.kind]);

  const newBoard = useCallback(async () => {
    if (!api) return;
    clearTimeout(timerRef.current);
    if (status.kind === 'dirty') await save();
    api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER });
    api.history.clear();
    versionRef.current = seenRef.current = getSceneVersion([]);
    setCurrent(null);
    setName('');
    history.replaceState(null, '', location.pathname);
    setStatus({ kind: 'idle', text: lang === 'fr-FR' ? 'Nouvelle planche : elle sera créée au premier trait.' : 'New board: created on your first stroke.' });
  }, [api, save, status.kind]);

  const removeBoard = useCallback(async () => {
    if (!current) return;
    const ok = window.confirm(lang === 'fr-FR' ? `Supprimer « ${current.name} » du serveur ?` : `Delete "${current.name}" from the server?`);
    if (!ok) return;
    clearTimeout(timerRef.current);
    try {
      await deleteBoard(current.id);
      api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER });
      api.history.clear();
      versionRef.current = seenRef.current = getSceneVersion([]);
      setCurrent(null);
      setName('');
      history.replaceState(null, '', location.pathname);
      setStatus({ kind: 'idle', text: lang === 'fr-FR' ? 'Planche supprimée.' : 'Board deleted.' });
      refresh();
    } catch (e) {
      setStatus({ kind: 'error', text: e.message });
    }
  }, [api, current, refresh]);

  const onRename = (value) => {
    setName(value);
    if (current) { setStatus({ kind: 'dirty', text: lang === 'fr-FR' ? 'Modifications non enregistrées' : 'Unsaved changes' }); scheduleSave(800); }
  };

  const panel = (
    <div className="deck-panel">
      <select className="deck-select" value={current ? current.id : ''} onChange={(e) => e.target.value ? loadBoard(e.target.value) : newBoard()} title={lang === 'fr-FR' ? 'Planches enregistrées' : 'Saved boards'}>
        <option value="">{lang === 'fr-FR' ? '+ Nouvelle planche' : '+ New board'}</option>
        {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <input className="deck-name" value={name} onChange={(e) => onRename(e.target.value)} placeholder={lang === 'fr-FR' ? 'Nom de la planche' : 'Board name'} />
      <button className="deck-btn" onClick={() => { clearTimeout(timerRef.current); save({ force: true }); }} title="Ctrl+S">{lang === 'fr-FR' ? 'Enregistrer' : 'Save'}</button>
      {current && <button className="deck-btn danger" onClick={removeBoard}>{lang === 'fr-FR' ? 'Supprimer' : 'Delete'}</button>}
      <span className={`deck-status ${status.kind}`}>{status.text}</span>
    </div>
  );

  if (!initialData) return <div className="deck-loading">…</div>;

  return (
    <div className="deck-board">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        onChange={onChange}
        langCode={lang}
        theme={theme}
        renderTopRightUI={() => panel}
        UIOptions={{ canvasActions: { loadScene: true, saveToActiveFile: false, export: { saveFileToDisk: true }, toggleTheme: true } }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>{lang === 'fr-FR' ? 'Planche vide. Dessine, ça s’enregistre tout seul.' : 'Blank board. Draw, it saves itself.'}</WelcomeScreen.Center.Heading>
            <WelcomeScreen.Center.Menu>
              <WelcomeScreen.Center.MenuItemLoadScene />
              <WelcomeScreen.Center.MenuItemHelp />
            </WelcomeScreen.Center.Menu>
          </WelcomeScreen.Center>
        </WelcomeScreen>
      </Excalidraw>
    </div>
  );
}
