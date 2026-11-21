import catalog from '../../../backend/scripts/runtime/operation-catalog.json' with {type:'json'};
export {catalog};

export const diagnosticApplicationKinds = {
  app: "Apps",
  addon: "Add-ons",
  plugin: "Plug-ins",
  bridge: "Bridges",
};

function searchText(value) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export function diagnosticApplicationOptions(packages = [], journalIds = []) {
  const options = new Map(packages.map(item => [item.id, item]));
  for (const id of journalIds) {
    if (options.has(id)) continue;
    const category = catalog.modules[id];
    options.set(id, { id, kind: id.split(".")[0], name: catalog.categories[category] || id });
  }
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name, "de") || left.id.localeCompare(right.id));
}

export function searchDiagnosticApplications(applications, query) {
  const term = searchText(query);
  return applications.filter(({ name, id, kind }) => (
    searchText([name, id, diagnosticApplicationKinds[kind]].join(" ")).includes(term)
  ));
}

function matchesDiagnosticQuery(group, term) {
  return group.entries.some(entry => searchText([
    group.moduleId,
    group.operationId,
    group.title,
    stageLabel(entry),
    entry.code,
    entry.requestId,
    entry.statusCode && `HTTP ${entry.statusCode}`,
    entry.appVersion,
  ].join(" ")).includes(term));
}

export function groupedDiagnostics(entries=[],{onlyErrors=false,query='',level='all',now=Date.now()}={}) {
 const term=searchText(query);
 const groups=new Map();
 for(const entry of entries){
  const key=`${entry.moduleId}:${entry.operationId||entry.id}`;
  if(!groups.has(key))groups.set(key,{key,moduleId:entry.moduleId,category:entry.category,operationId:entry.operationId,entries:[]});
  groups.get(key).entries.push(entry);
 }
 return [...groups.values()].map(group=>{
  const rows=group.entries,last=rows.at(-1),failed=rows.filter(e=>['error','critical'].includes(e.level)||catalog.stages[e.phase]?.[1]==='failed').at(-1);
  const displayed=rows.filter(e=>e.phase==='image-displayed').at(-1);
  const workflow=rows.find(e=>e.workflow)?.workflow;
  const requestDone=workflow==='app-request'&&last.phase==='request-succeeded';
  const success=displayed&&(!failed||Date.parse(displayed.timestamp)>Date.parse(failed.timestamp));
  const cancelled=catalog.stages[last.phase]?.[1]==='cancelled';
  const status=success||requestDone?'succeeded':failed?'failed':cancelled?'cancelled':!group.operationId?'log':'progress';
  const selected=failed&&status==='failed'?failed:last;
  const waiting=last.phase==='picker-requested'&&now-Date.parse(last.timestamp)>10000;
  return {...group,last,selected,status,workflow,waiting,title:catalog.workflows[workflow]||selected.message||selected.code||'Technische Meldung'};
 }).filter(group=>!onlyErrors||group.status==='failed')
 .filter(group=>level==='all'||group.entries.some(e=>e.level===level||(level==='error'&&e.level==='critical')))
 .filter(group=>!term||matchesDiagnosticQuery(group,term))
 .sort((a,b)=>Date.parse(b.last.timestamp)-Date.parse(a.last.timestamp));
}
export const stageLabel=entry=>catalog.stages[entry.phase]?.[0]||entry.message||entry.code||'Technische Meldung';
export function diagnosticHint(group){
 const e=group.selected;
 if(e.code==='DIAGNOSTIC_TEST_ENTRY')return 'Dieser Eintrag wurde im Terminal erzeugt, um die Fehleranzeige zu prüfen.';
 if(group.waiting)return 'Noch keine Dateiauswahl bestätigt. Der Systemdialog kann offen sein oder nicht gestartet worden sein; daraus folgt noch kein Fehler.';
 if(e.code==='CORE_MEDIA_NOT_FOUND')return 'Die gespeicherte Referenz ist vorhanden, die Originaldatei wurde jedoch nicht gefunden. Ablage und vorhandene Sicherung prüfen.';
 if(e.statusCode===403||/PERMISSION|ACCESS_DENIED|FORBIDDEN|MFA/.test(e.code||''))return 'Berechtigung und gegebenenfalls die bestätigte Zwei-Faktor-Sitzung prüfen.';
 if(e.statusCode===413||/TOO_LARGE/.test(e.code||''))return 'Die zulässige Dateigröße wurde überschritten.';
 if(/CONTENT|FORMAT|BASE64/.test(e.code||''))return 'Dateiformat und Bilddatenprüfung untersuchen; die Originaldatei bleibt unverändert.';
 if(e.code==='DIAGNOSTIC_UNKNOWN_ERROR')return 'Der genaue Code ist noch nicht im technischen Diagnosekatalog. Die geschützte Rohansicht kann zusätzliche Struktur liefern.';
 return '';
}
