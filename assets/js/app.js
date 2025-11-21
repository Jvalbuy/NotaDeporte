/* Full app.js for SSAA - handles Firebase auth, Firestore, calculations, UI events, charts, exports */

// globals
let baremos = null;
let currentUser = null;
let db = null;
let radarChart = null;
let barChart = null;

// load baremos
async function loadBaremos(){
  try {
    const res = await fetch('data/baremos.json');
    baremos = await res.json();
  } catch(e) {
    console.error('Error loading baremos', e);
    baremos = {};
  }
}

// helpers
function parseTimeToMinutes(t){
  if(!t) return 0;
  t = String(t).trim();
  if(t.includes(':')){
    const [m,s] = t.split(':').map(x=>x.trim());
    if(isNaN(m) || isNaN(s)) return 0;
    return parseFloat(m) + parseFloat(s)/60;
  }
  if(/^\d{3,4}$/.test(t)){
    const len = t.length;
    const s = t.slice(-2);
    const m = t.slice(0,len-2);
    return parseFloat(m) + parseFloat(s)/60;
  }
  if(!isNaN(t)) return parseFloat(t);
  return 0;
}

function buscarNota(valor, tablaObj, invertido=false){
  const items = Object.entries(tablaObj || {}).map(([k,v])=>[parseFloat(k), parseFloat(v)]);
  items.sort((a,b)=> invertido ? a[0]-b[0] : b[0]-a[0]);
  for(const [k,v] of items){
    if((!invertido && valor >= k) || (invertido && valor <= k)) return v;
  }
  return items.length ? items[items.length-1][1] : 0;
}

function validarNotaYMensaje(prueba, valor, notaCalculada){
  if(notaCalculada > 10){
    return {nota: 10, mensaje: 'Vale flipad@, deja algo para los demás.' , tipo: 'capped'};
  }
  if(notaCalculada < 5){
    return {nota: 0, mensaje: 'Con esa marca estás suspens@, superarte es tu siguiente misión. ¡A por ello!', tipo: 'fail'};
  }
  return {nota: notaCalculada, mensaje: null, tipo: null};
}

function calcularNotas(sexo, salto, flexiones, velocidad, mil, natacion, seis){
  const tabla = baremos[sexo] || {};
  const mil_t = parseTimeToMinutes(mil);
  const seis_t = parseTimeToMinutes(seis);

  const rawNotas = {
    'Salto': buscarNota(salto, tabla['Salto'] || {}),
    'Flexiones': buscarNota(flexiones, tabla['Flexiones'] || {}),
    'Velocidad': buscarNota(velocidad, tabla['Velocidad'] || {}, true),
    '1000m': buscarNota(mil_t, tabla['1000m'] || {}, true),
    'Natación': buscarNota(natacion, tabla['Natación'] || {}, true),
    '6000m': buscarNota(seis_t, tabla['6000m'] || {}, true)
  };

  const notas = {};
  const mensajes = [];

  for(const [k,v] of Object.entries(rawNotas)){
    const res = validarNotaYMensaje(k, null, v);
    notas[k] = res.nota;
    if(res.mensaje) mensajes.push({prueba: k, texto: res.mensaje, tipo: res.tipo});
  }

  const media = Object.values(notas).reduce((a,b)=>a+b,0)/Object.values(notas).length || 0;
  const nota_final = media * 0.9;
  return {notas, media, nota_final, mensajes};
}

// Firebase init
function initFirebase(){
  if(typeof firebaseConfig === 'undefined'){
    console.error('firebaseConfig not found. Please set assets/js/firebaseConfig.js');
    return null;
  }
  const app = firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
  db = firebase.firestore();
  auth.onAuthStateChanged(user=>{
    if(user){
      currentUser = user;
      document.getElementById('user-email').textContent = user.email;
      document.getElementById('user-uid').textContent = user.uid;
      document.getElementById('user-info').style.display = 'block';
      document.getElementById('auth-forms').style.display = 'none';
      document.getElementById('btn-logout').style.display = 'inline-block';
      loadUserEvaluations();
    } else {
      currentUser = null;
      document.getElementById('user-info').style.display = 'none';
      document.getElementById('auth-forms').style.display = 'block';
      document.getElementById('btn-logout').style.display = 'none';
      document.getElementById('summary-content').style.display = 'none';
      document.getElementById('export-actions').style.display = 'none';
      document.getElementById('chartsPanel').style.display = 'none';
      document.getElementById('evaluations-list').style.display = 'block';
    }
  });
  return auth;
}

async function createAccount(auth, email, password){
  if(!email || !password) throw new Error('Email y contraseña son obligatorios');
  const userCred = await auth.createUserWithEmailAndPassword(email, password);
  await db.collection('users').doc(userCred.user.uid).set({email});
  return userCred.user;
}

async function signIn(auth, email, password){
  if(!email || !password) throw new Error('Email y contraseña son obligatorios');
  const userCred = await auth.signInWithEmailAndPassword(email, password);
  return userCred.user;
}

async function signOut(auth){
  await auth.signOut();
}

// Save evaluation
async function saveEvaluation(evalObj){
  if(!currentUser) throw new Error('No user logged in');
  const ref = db.collection('users').doc(currentUser.uid).collection('evaluations');
  const doc = await ref.add({...evalObj, createdAt: firebase.firestore.FieldValue.serverTimestamp()});
  return doc.id;
}

async function loadUserEvaluations(){
  if(!currentUser) return;
  const ref = db.collection('users').doc(currentUser.uid).collection('evaluations').orderBy('createdAt','desc');
  const snap = await ref.get();
  const list = document.getElementById('list-evals');
  list.innerHTML = '';
  const evals = [];
  snap.forEach(doc=>{
    const data = doc.data();
    evals.push({id:doc.id, ...data});
  });
  if(evals.length === 0){
    list.innerHTML = '<p>No tienes evaluaciones guardadas.</p>';
    document.getElementById('summary-content').style.display = 'none';
    document.getElementById('export-actions').style.display = 'none';
    document.getElementById('chartsPanel').style.display = 'none';
    return;
  }
  let acumFinals = 0;
  evals.forEach(e=>{
    const card = document.createElement('div');
    card.className = 'eval-card';
    const created = e.createdAt && e.createdAt.toDate ? e.createdAt.toDate().toLocaleString() : '';
    const finalWithConcept = (e.nota_final_concepto !== undefined) ? e.nota_final_concepto : e.nota_final;
    card.innerHTML = `<strong>Evaluación:</strong> ${created}<br>
      <strong>Nota final (×0.9):</strong> ${e.nota_final.toFixed(2)}<br>
      <strong>Concepto aplicado:</strong> ${ (e.concepto || 0) }<br>
      <strong>Final con concepto:</strong> ${ finalWithConcept.toFixed(2) }<br>
      <button data-id="${e.id}" class="btn-delete">Eliminar</button>
    `;
    list.appendChild(card);
    acumFinals += finalWithConcept;
  });
  const mediaGlobal = acumFinals / evals.length;
  document.getElementById('sum-media').textContent = mediaGlobal.toFixed(2);
  document.getElementById('sum-final').textContent = mediaGlobal.toFixed(2);
  document.getElementById('summary-content').style.display = 'block';
  document.getElementById('export-actions').style.display = 'block';
  document.getElementById('chartsPanel').style.display = 'block';
  document.querySelectorAll('.btn-delete').forEach(b=>{
    b.addEventListener('click', async (ev)=>{
      const id = ev.target.getAttribute('data-id');
      if(confirm('Eliminar esta evaluación?')) {
        await db.collection('users').doc(currentUser.uid).collection('evaluations').doc(id).delete();
        loadUserEvaluations();
      }
    });
  });
  const last = evals[0];
  updateCharts(last.notas || {'Salto':0,'Flexiones':0,'Velocidad':0,'1000m':0,'Natación':0,'6000m':0});
}

// UI helpers
function renderTable(notas){
  const tbody = document.querySelector('#tabla-resultados tbody');
  tbody.innerHTML='';
  for(const [k,v] of Object.entries(notas)){
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = k;
    const td2 = document.createElement('td'); td2.textContent = v.toFixed(2);
    tr.appendChild(td1); tr.appendChild(td2);
    if(v >= 8.5) tr.style.background = 'rgba(16,185,129,0.08)';
    else if(v >= 6.5) tr.style.background = 'rgba(245,158,11,0.06)';
    else tr.style.background = 'rgba(239,68,68,0.04)';
    tbody.appendChild(tr);
  }
}

function exportCSVForUser(){
  if(!currentUser) return alert('Inicia sesión');
  (async ()=>{
    const snap = await db.collection('users').doc(currentUser.uid).collection('evaluations').orderBy('createdAt','desc').get();
    const rows = [['Evaluación','Nota final','Concepto','Final con concepto']];
    snap.forEach(doc=>{
      const d = doc.data();
      rows.push([ (d.createdAt && d.createdAt.toDate)? d.createdAt.toDate().toLocaleString() : doc.id, (d.nota_final||0).toFixed(2), (d.concepto||0), (d.nota_final_concepto||d.nota_final||0).toFixed(2) ]);
    });
    const csv = rows.map(r=> r.map(c=>`"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'evaluaciones_usuario.csv'; a.click(); URL.revokeObjectURL(url);
  })();
}

async function exportPDF(){
  const element = document.querySelector('.app');
  const canvas = await html2canvas(element, {scale: 2});
  const imgData = canvas.toDataURL('image/png');
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p','mm','a4');
  const imgProps = pdf.getImageProperties(imgData);
  const pdfWidth = pdf.internal.pageSize.getWidth();
  const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
  pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
  pdf.save('resultados_fisicas.pdf');
}

// charts
function createCharts(){
  const radarCtx = document.getElementById('radarChart').getContext('2d');
  radarChart = new Chart(radarCtx, {
    type: 'radar',
    data: {
      labels: ['Salto','Flexiones','Velocidad','1000m','Natación','6000m'],
      datasets: [{ label: 'Notas', data: [0,0,0,0,0,0], fill:true, tension:0.4 }]
    },
    options: { scales:{ r:{ suggestedMin:0, suggestedMax:10 } } }
  });
  const barCtx = document.getElementById('barChart').getContext('2d');
  barChart = new Chart(barCtx, {
    type: 'bar',
    data: { labels: ['Salto','Flexiones','Velocidad','1000m','Natación','6000m'], datasets:[{ label:'Notas', data:[0,0,0,0,0,0]}] },
    options: { scales:{ y:{ suggestedMin:0, suggestedMax:10 } } }
  });
}

function updateCharts(notas){
  const labels = ['Salto','Flexiones','Velocidad','1000m','Natación','6000m'];
  const data = labels.map(l => notas[l] || 0);
  if(radarChart){ radarChart.data.datasets[0].data = data; radarChart.update(); }
  if(barChart){ barChart.data.datasets[0].data = data; barChart.update(); }
}

// wire UI
window.addEventListener('DOMContentLoaded', async ()=>{
  await loadBaremos();
  createCharts();

  const auth = initFirebase();
  const btnSignup = document.getElementById('btn-signup');
  const btnLogin = document.getElementById('btn-login');
  const btnLogout = document.getElementById('btn-logout');
  const btnCalcular = document.getElementById('calcular');
  const btnGuardar = document.getElementById('guardar');
  const btnLimpiar = document.getElementById('limpiar');
  const btnExport = document.getElementById('exportExcel');
  const btnPDF = document.getElementById('exportPDF');
  const btnApplyConcept = document.getElementById('applyConcept');

  let lastCalc = null;

  btnSignup.addEventListener('click', async ()=>{
    try{
      const email = document.getElementById('email').value.trim();
      const pw = document.getElementById('password').value.trim();
      await createAccount(auth, email, pw);
      alert('Cuenta creada. Ahora puedes iniciar sesión.');
    }catch(e){ alert('Error al crear cuenta: '+e.message); console.error(e); }
  });

  btnLogin.addEventListener('click', async ()=>{
    try{
      const email = document.getElementById('email').value.trim();
      const pw = document.getElementById('password').value.trim();
      await signIn(auth, email, pw);
    }catch(e){ alert('Error al iniciar sesión: '+e.message); console.error(e); }
  });

  btnLogout.addEventListener('click', async ()=>{
    try{ await signOut(auth); }catch(e){ console.error(e); }
  });

  btnCalcular.addEventListener('click', ()=>{
    try{
      const sexo = document.getElementById('sexo').value;
      const salto = parseFloat(document.getElementById('salto').value) || 0;
      const flexiones = parseFloat(document.getElementById('flexiones').value) || 0;
      const velocidad = parseFloat(document.getElementById('velocidad').value) || 0;
      const natacion = parseFloat(document.getElementById('natacion').value) || 0;
      const mil = document.getElementById('mil').value || '';
      const seis = document.getElementById('seis').value || '';
      const result = calcularNotas(sexo, salto, flexiones, velocidad, mil, natacion, seis);
      renderTable(result.notas);
      document.getElementById('concepto').value = 0;
      document.getElementById('applyConcept').disabled = false;
      document.getElementById('guardar').disabled = false;
      lastCalc = result;
      const msgDiv = document.getElementById('mensajes');
      msgDiv.innerHTML = '';
      if(result.mensajes.length === 0) msgDiv.innerHTML = '<p style="color:#6b7280">No hay mensajes especiales.</p>';
      else result.mensajes.forEach(m=>{ const d = document.createElement('div'); d.className='msg '+(m.tipo==='fail'?'fail':'capped'); d.innerHTML = `<strong>${m.prueba}:</strong> ${m.texto}`; msgDiv.appendChild(d); });
      updateCharts(result.notas);
    }catch(e){ alert('Error en cálculo: '+e.message); console.error(e); }
  });

  btnApplyConcept.addEventListener('click', ()=>{ 
    if(!lastCalc) return alert('Primero calcula la evaluación');
    let concepto = parseFloat(document.getElementById('concepto').value) || 0;
    concepto = Math.max(0, Math.min(1, concepto));
    lastCalc.nota_final_concepto = Math.min(10, lastCalc.nota_final + concepto);
    lastCalc.concepto = concepto;
    document.getElementById('sum-media').textContent = lastCalc.media.toFixed(2);
    document.getElementById('sum-final').textContent = lastCalc.nota_final_concepto.toFixed(2);
  });

  btnGuardar.addEventListener('click', async ()=>{
    if(!currentUser) return alert('Debes iniciar sesión para guardar');
    if(!lastCalc) return alert('Calcula primero');
    try{
      const evalObj = {
        sexo: document.getElementById('sexo').value,
        notas: lastCalc.notas,
        media: lastCalc.media,
        nota_final: lastCalc.nota_final,
        concepto: lastCalc.concepto || 0,
        nota_final_concepto: lastCalc.nota_final_concepto || lastCalc.nota_final
      };
      await saveEvaluation(evalObj);
      alert('Evaluación guardada');
      loadUserEvaluations();
    }catch(e){ alert('Error guardando evaluación: '+e.message); console.error(e); }
  });

  btnLimpiar.addEventListener('click', ()=>{
    document.querySelectorAll('input[type="number"], input[type="text"]').forEach(i=>i.value='');
    document.querySelector('#tabla-resultados tbody').innerHTML='';
    document.getElementById('concepto').value = 0;
    document.getElementById('applyConcept').disabled = true;
    document.getElementById('guardar').disabled = true;
  });

  btnExport.addEventListener('click', exportCSVForUser);
  btnPDF.addEventListener('click', async ()=>{
    try{ await exportPDF(); }catch(e){ alert('Error PDF: '+e.message); console.error(e); }
  });

});
