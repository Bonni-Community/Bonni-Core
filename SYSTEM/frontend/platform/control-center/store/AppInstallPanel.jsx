import {forwardRef,useEffect,useImperativeHandle,useState} from 'react';
import {apiRequest} from '../../../system/api/apiClient.js';
const base='/api/update/apps';
export default forwardRef(function AppInstallPanel({open,onClose,token,onInstalled,onChecked,onOperation,onRefresh},ref) {
  const [data,setData] = useState({ availableUpdates: [] });
  const [repo,setRepo] = useState(null);
  const [savingSource,setSavingSource] = useState(false);
  const [sourceFeedback,setSourceFeedback] = useState(null);
  const [busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const blocked=busy||checking;
  useEffect(()=>{onChecked?.(data);},[data,onChecked]);
  useEffect(()=>{onOperation?.({busy:blocked,message,error});},[blocked,message,error,onOperation]);
  useImperativeHandle(ref,()=>({refresh:load,install}));
  async function load() {
    setBusy(true);setError('');setMessage('UPDATE-Ordner und anschließend GitHub werden geprüft …');
    try {
      const next = await apiRequest(base + '/check', { token, method: 'POST', allowFailover: false });
      setData(previous => ({ ...next, inbox: next.inbox ?? previous.inbox }));
      await onRefresh?.();
      setMessage('Prüfung abgeschlossen.');
    }
    catch(e){setError(e.message||'App-Pakete konnten nicht geprüft werden.');setMessage('');}
    finally {setBusy(false);}
  }
  useEffect(()=>{
    let alive=true;
    setRepo(null);
    setSourceFeedback(null);
    async function status() {
      try {
        const next=await apiRequest(base+'/check-status',{token});if(!alive)return;
        setChecking(next.checking);
        setRepo(current => current ?? next.repository ?? '');
        if(next.result)setData({...next.result,inbox:next.inbox??next.result.inbox});
        else setData(previous=>({...previous,inbox:next.inbox??previous.inbox}));
      } catch(e){if(alive)setError(e.message||'Prüfstatus konnte nicht geladen werden.');}
    }
    void status();const timer=setInterval(()=>void status(),15000);
    return ()=>{alive=false;clearInterval(timer);};
  },[token]);
  async function save() {
    if (repo === null || savingSource) return;
    setSavingSource(true);
    setSourceFeedback(null);
    try {
      const repository = repo.trim();
      const saved = await apiRequest(base + '/settings', { token, method: 'PUT', body: { repository } });
      setRepo(saved?.repository ?? repository);
      setSourceFeedback({ message: 'Paketquelle gespeichert.' });
    } catch (failure) {
      setSourceFeedback({ message: failure.message || 'Paketquelle konnte nicht gespeichert werden.', error: true });
    } finally {
      setSavingSource(false);
    }
  }
  async function install(item,source) {
    const acceptDevRisk=item.channel==='dev'&&window.confirm('DEV-Version '+item.version+' installieren? Diese Entwicklungsversion ist noch nicht abschließend geprüft und kann Fehler enthalten.');
    if(item.channel==='dev'&&!acceptDevRisk)return;
    setBusy(true);setError('');setMessage('App wird geprüft, gesichert und installiert …');
    try {
      const result=await apiRequest(base+'/install',{token,allowFailover:false,method:'POST',body:{source,acceptDevRisk,appId:item.appId,version:item.version,filename:item.filename,sha256:item.sha256}});
      if(result.ok!==true)throw new Error(result.message||'Installation nicht bestätigt.');
      await onInstalled?.();await load();
      setMessage(result.alreadyInstalled?'Diese Ausgabe ist bereits installiert.':item.appId+' '+item.version+' wurde installiert und aktiviert.');
    } catch(e){setMessage('');setError(e.message||'Die App konnte nicht installiert werden.');}
    finally {setBusy(false);}
  }
  if (!open) return null;
  const loadingSource = repo === null;
  const sourceBlocked = loadingSource || savingSource;
  const sourceStatus = savingSource ? 'Paketquelle wird gespeichert …'
    : sourceFeedback?.message ?? (loadingSource ? error || 'Paketquellen werden geladen …' : '');
  const sourceError = sourceFeedback?.error || (loadingSource && !!error);

  return (
    <div className="store-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="store-settings-dialog store-app-settings-dialog" role="dialog" aria-modal="true"
        aria-labelledby="store-settings-title" aria-busy={savingSource || (loadingSource && !error)}
        onMouseDown={(event) => event.stopPropagation()}>
        <header className="store-settings-dialog__header">
          <div>
            <p className="store-eyebrow">Store</p>
            <h2 id="store-settings-title">Einstellungen</h2>
            <p>Paketquellen für den Store.</p>
          </div>
          <button type="button" className="store-detail__close" onClick={onClose} aria-label="Einstellungen schließen">×</button>
        </header>

        <form className="store-app-settings-form" onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}>
          <div className="store-app-settings-card">
            <div className="store-settings-field">
              <label htmlFor="store-settings-repository">GitHub-Repository</label>
              <input id="store-settings-repository" value={repo ?? ''} disabled={sourceBlocked}
                onChange={(event) => {
                  setRepo(event.target.value);
                  setSourceFeedback(null);
                }}
                placeholder="Besitzer/Repository" aria-describedby="store-settings-repository-hint" />
              <small id="store-settings-repository-hint">Optionales öffentliches Repository für Online-Pakete.</small>
            </div>
            <div className="store-app-settings-inbox">
              <strong>Lokaler UPDATE-Ordner</strong>
              <code>{data.inbox || 'UPDATE'}</code>
              <small>Signierte App-ZIPs unverändert hier ablegen.</small>
            </div>
          </div>

          <div className="store-detail-actions store-settings-dialog__footer">
            {sourceStatus ? <p className="store-app-settings-feedback" role={sourceError ? 'alert' : 'status'}>{sourceStatus}</p> : null}
            <button type="submit" className="is-primary" disabled={sourceBlocked}>Speichern</button>
          </div>
        </form>
      </section>
    </div>
  );
});
