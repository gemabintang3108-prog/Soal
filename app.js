/* =========================================================
   PRESENSI SEKOLAH - FIRESTORE VERSION (FINAL)
   ========================================================= */

const CONFIG = {
  SCHOOL_NAME: "SMAN 12",
  ACCOUNT_STORAGE_KEY: "ABSEN_ACCOUNTS_DB",
  USERS: [
    {
      username: "admin",
      password: "admin123",
      role: "admin",
      displayName: "Administrator"
    }
  ]
};

const DAFTAR_KELAS = [
  "X-1","X-2","X-3","X-4","X-5","X-6",
  "XI-1","XI-2","XI-3","XI-4","XI-5","XI-6",
  "XII-1","XII-2","XII-3","XII-4","XII-5","XII-6"
];

let localDB = {};
let settings = {
  lateCutoff: "06:30",
  alpaCutoff: "08:00"
};

let session = {
  username: null,
  displayName: null,
  role: null,
  kelas: null,
  mode: "HADIR",
  parentAbsen: null,
  parentPhone: null,
  piketToday: false,
  isWaliKelas: false,
  waliKelas: null,
  nip: null,
  mengajar: []
};

const scanners = {
  admin: null, wali: null, sekretaris: null, piket: null, pelajaran: null
};

const scanMemory = {
  admin: { text: "", at: 0 }, wali: { text: "", at: 0 },
  sekretaris: { text: "", at: 0 }, piket: { text: "", at: 0 }, pelajaran: { text: "", at: 0 }
};

const SCAN_COOLDOWN_MS = 1600;
let modalTarget = { kelas: null, absen: null, chosenStatus: "HADIR" };
let parentWatchInterval = null;
let lastParentStatusKey = "";
let unsubscribers = {};

let accountsDB = [];
let picketScheduleDB = null;
let teacherAttendanceDB = [];
let currentLessonSessionId = null;
let activeRoleTab = null;

function defaultAccounts(){
  return (CONFIG.USERS || []).map(acc => ({ ...acc }));
}

function normalizeAccount(acc){
  return {
    username: String(acc?.username || "").trim(),
    password: String(acc?.password || ""),
    role: String(acc?.role || "").trim(),
    kelas: acc?.kelas ? String(acc.kelas).trim() : null,
    displayName: String(acc?.displayName || acc?.username || "").trim(),
    nip: String(acc?.nip || "").trim(),
    mengajar: Array.isArray(acc?.mengajar) ? acc.mengajar.map(x => normalizeClassName(x)).filter(Boolean) : String(acc?.mengajar || "").split(",").map(x => normalizeClassName(x)).filter(Boolean),
    parentAbsen: acc?.parentAbsen ? normalizeAbsen(acc.parentAbsen) : null,
    parentPhone: acc?.parentPhone ? normalizePhone(acc.parentPhone) : null,
    isWaliKelas: !!(acc?.isWaliKelas || acc?.waliKelas?.enabled),
    waliKelas: acc?.waliKelas?.kelas ? String(acc.waliKelas.kelas).trim() : (acc?.waliKelas ? String(acc.waliKelas).trim() : null)
  };
}

function applyAccountRules(acc){
  const out = normalizeAccount(acc);
  if (!["guru", "orangtua"].includes(out.role)) out.kelas = null;
  if (out.role !== "orangtua") {
    out.parentAbsen = null;
    out.parentPhone = null;
  }
  if (out.role !== "guru") {
    out.isWaliKelas = false;
    out.waliKelas = null;
    out.nip = "";
    out.mengajar = [];
  }
  if (out.role === "guru" && out.isWaliKelas) {
    out.kelas = out.waliKelas || out.kelas || null;
  }
  return out;
}

function saveAccountsCache(){
  localStorage.setItem(CONFIG.ACCOUNT_STORAGE_KEY, JSON.stringify(accountsDB));
}

function restoreAccountsCache(){
  const raw = localStorage.getItem(CONFIG.ACCOUNT_STORAGE_KEY);
  if (!raw) {
    accountsDB = defaultAccounts();
    saveAccountsCache();
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    accountsDB = Array.isArray(parsed) ? parsed.map(applyAccountRules).filter(a => a.username && a.role) : defaultAccounts();
  } catch {
    accountsDB = defaultAccounts();
  }
  if (!accountsDB.some(a => a.role === "admin")) {
    accountsDB.unshift(defaultAccounts()[0]);
  }
  saveAccountsCache();
}

async function loadAccountsFromFirestore(){
  restorePicketScheduleCache();
  restoreTeacherAttendanceCache();

  try {
    const db = firebase.firestore();
    const doc = await db.collection("settings").doc("accounts").get();
    if (!doc.exists) {
      await saveAccountsToFirestore();
      return;
    }
    const data = doc.data() || {};
    const arr = Array.isArray(data.accounts) ? data.accounts : [];
    if (arr.length) {
      accountsDB = arr.map(applyAccountRules).filter(a => a.username && a.role);
      if (!accountsDB.some(a => a.role === "admin")) accountsDB.unshift(defaultAccounts()[0]);
      saveAccountsCache();
    }
  } catch (e) {
    console.error("Gagal load accounts:", e);
  }
}

async function saveAccountsToFirestore(){
  try {
    const db = firebase.firestore();
    await db.collection("settings").doc("accounts").set({
      accounts: accountsDB.map(applyAccountRules),
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (e) {
    console.error("Gagal simpan accounts:", e);
    throw e;
  }
}

function findAccountByUsername(username){
  const needle = String(username || "").trim().toLowerCase();
  return accountsDB.find(a => a.username.toLowerCase() === needle) || null;
}

function validateCurrentAdminPassword(password){
  const current = accountsDB.find(a => a.username === session.username && a.role === "admin");
  return !!current && current.password === password;
}

function populateAccountClassSelect(){
  const sel = $("acc-kelas");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Pilih Kelas (jika perlu)</option>';
  DAFTAR_KELAS.forEach(k => {
    sel.innerHTML += `<option value="${k}">${k}</option>`;
  });
  if (current) sel.value = current;
  const selS = $("acc-siswa-kelas");
  if (selS) { const c = selS.value; selS.innerHTML = '<option value="">Pilih Kelas</option>' + DAFTAR_KELAS.map(k=>`<option value="${k}">${k}</option>`).join(''); if (c) selS.value = c; }
}

function toggleAccountFieldVisibility(){
  const role = $("acc-role")?.value || "admin";
  const guruWrap = $("acc-guru-wrap");
  const guruExtraWrap = $("acc-guru-extra-wrap");
  const siswaWrap = $("acc-siswa-wrap");
  const kelasWrap = $("acc-kelas-wrap");
  const absenWrap = $("acc-absen-wrap");
  const hpWrap = $("acc-hp-wrap");
  guruWrap?.classList.toggle("hidden", role !== "guru");
  guruExtraWrap?.classList.toggle("hidden", role !== "guru");
  siswaWrap?.classList.toggle("hidden", role !== "siswa");
  kelasWrap?.classList.toggle("hidden", role !== "orangtua");
  absenWrap?.classList.toggle("hidden", role !== "orangtua");
  hpWrap?.classList.toggle("hidden", role !== "orangtua");
  if (role !== "guru") {
    if ($("acc-is-wali")) $("acc-is-wali").checked = false;
    if ($("acc-wali-kelas")) $("acc-wali-kelas").value = "";
    if ($("acc-guru-nip")) $("acc-guru-nip").value = $("acc-guru-nip")?.value || "";
  }
}

function resetAccountForm(){
  if ($("acc-form-title")) $("acc-form-title").textContent = "Buat Akun Baru";
  if ($("acc-edit-index")) $("acc-edit-index").value = "";
  if ($("acc-name")) $("acc-name").value = "";
  if ($("acc-username")) $("acc-username").value = "";
  if ($("acc-password")) $("acc-password").value = "";
  if ($("acc-role")) $("acc-role").value = "admin";
  if ($("acc-guru-nip")) $("acc-guru-nip").value = "";
  if ($("acc-guru-mengajar")) $("acc-guru-mengajar").value = "";
  if ($("acc-siswa-nik")) $("acc-siswa-nik").value = "";
  if ($("acc-siswa-nisn")) $("acc-siswa-nisn").value = "";
  if ($("acc-siswa-nis")) $("acc-siswa-nis").value = "";
  if ($("acc-siswa-nama")) $("acc-siswa-nama").value = "";
  if ($("acc-siswa-kelas")) $("acc-siswa-kelas").value = "";
  if ($("acc-siswa-jenis")) $("acc-siswa-jenis").value = "L";
  if ($("acc-siswa-agama")) $("acc-siswa-agama").value = "Islam";
  if ($("acc-kelas")) $("acc-kelas").value = "";
  if ($("acc-absen")) $("acc-absen").value = "";
  if ($("acc-hp")) $("acc-hp").value = "";
  if ($("acc-is-wali")) $("acc-is-wali").checked = false;
  if ($("acc-wali-kelas")) $("acc-wali-kelas").value = "";
  if ($("btn-account-save")) $("btn-account-save").textContent = "Simpan Data";
  if ($("acc-edit-student-nik")) $("acc-edit-student-nik").value = "";
  toggleAccountFieldVisibility();
}

function startEditAccount(index){
  const acc = accountsDB[index];
  if (!acc) return;
  if ($("acc-form-title")) $("acc-form-title").textContent = "Edit Akun";
  if ($("acc-edit-index")) $("acc-edit-index").value = String(index);
  if ($("acc-name")) $("acc-name").value = acc.displayName || "";
  if ($("acc-username")) $("acc-username").value = acc.username || "";
  if ($("acc-password")) $("acc-password").value = acc.password || "";
  if ($("acc-role")) $("acc-role").value = acc.role || "admin";
  populateAccountClassSelect();
  if ($("acc-kelas")) $("acc-kelas").value = acc.kelas || "";
  if ($("acc-absen")) $("acc-absen").value = acc.parentAbsen || "";
  if ($("acc-hp")) $("acc-hp").value = acc.parentPhone || "";
  if ($("acc-guru-nip")) $("acc-guru-nip").value = acc.nip || "";
  if ($("acc-guru-mengajar")) $("acc-guru-mengajar").value = Array.isArray(acc.mengajar) ? acc.mengajar.join(", ") : "";
  if ($("acc-is-wali")) $("acc-is-wali").checked = !!acc.isWaliKelas;
  if ($("acc-wali-kelas")) $("acc-wali-kelas").value = acc.waliKelas || acc.kelas || "";
  if ($("btn-account-save")) $("btn-account-save").textContent = "Update Akun";
  toggleAccountFieldVisibility();
}

function renderAccounts(){
  const box = $("account-list");
  if (!box) return;
  box.innerHTML = "";
  if (!accountsDB.length) {
    box.innerHTML = '<div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Belum ada akun.</div>';
    return;
  }
  accountsDB.forEach((acc, idx) => {
    const meta = [
      acc.role?.toUpperCase() || "-",
      acc.role === "guru" && acc.isWaliKelas && acc.waliKelas ? `WALI ${acc.waliKelas}` : null,
      acc.role === "orangtua" && acc.kelas ? `KELAS ${acc.kelas}` : null,
      acc.role === "orangtua" && acc.parentAbsen ? `ABSEN ${acc.parentAbsen}` : null,
      acc.role === "guru" && acc.nip ? `NIP ${acc.nip}` : null,
      acc.role === "guru" && acc.mengajar?.length ? `NGAJAR ${acc.mengajar.join(", ")}` : null
    ].filter(Boolean).join(" • ");
    box.innerHTML += `
      <div class="glass p-4 rounded-[1.75rem] flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <div class="text-xs font-black uppercase tracking-widest text-white">${acc.displayName || acc.username}</div>
          <div class="text-[10px] uppercase tracking-widest text-cyan-300 font-bold mt-1">@${acc.username}</div>
          <div class="text-[10px] uppercase tracking-widest text-gray-400 font-bold mt-2">${meta}</div>
        </div>
        <div class="flex gap-2">
          <button onclick="startEditAccount(${idx})" class="px-4 py-2 rounded-xl border border-cyan-500/30 text-cyan-300 text-[10px] font-black uppercase tracking-widest hover:bg-cyan-500/10 transition-all">Edit</button>
          <button onclick="deleteAccount(${idx})" class="px-4 py-2 rounded-xl border border-red-500/30 text-red-400 text-[10px] font-black uppercase tracking-widest hover:bg-red-500/10 transition-all">Hapus</button>
        </div>
      </div>`;
  });
}

async function saveAccountForm(){
  if (session.role !== "admin") return toast("Hanya admin yang bisa mengelola akun.");
  const editIndex = $("acc-edit-index")?.value;
  const username = String($("acc-username")?.value || "").trim();
  const password = String($("acc-password")?.value || "").trim();
  const role = String($("acc-role")?.value || "").trim();
  const displayName = String($("acc-name")?.value || "").trim();
  const kelas = String($("acc-kelas")?.value || "").trim();
  const parentAbsen = String($("acc-absen")?.value || "").trim();
  const parentPhone = String($("acc-hp")?.value || "").trim();
  const isWaliKelas = !!($("acc-is-wali")?.checked);
  const waliKelas = String($("acc-wali-kelas")?.value || "").trim();

  const nip = String($("acc-guru-nip")?.value || "").trim();
  const mengajarRaw = String($("acc-guru-mengajar")?.value || "").trim();
  const mengajar = mengajarRaw ? mengajarRaw.split(/[;,\n]+/).map(x => normalizeClassName(x)).filter(Boolean) : [];
  const siswaNik = String($("acc-siswa-nik")?.value || "").trim();
  const siswaNisn = String($("acc-siswa-nisn")?.value || "").trim();
  const siswaNis = String($("acc-siswa-nis")?.value || "").trim();
  const siswaNama = String($("acc-siswa-nama")?.value || "").trim();
  const siswaKelas = String($("acc-siswa-kelas")?.value || "").trim();
  const siswaJenis = String($("acc-siswa-jenis")?.value || "").trim();
  const siswaAgama = String($("acc-siswa-agama")?.value || "").trim();

  if (role !== "siswa" && (!username || !password || !role)) return toast("Username, password, dan role wajib diisi.");
  if (!["admin", "guru", "orangtua", "siswa"].includes(role)) return toast("Role akun tidak valid.");
  if (role === "orangtua" && !kelas) return toast("Kelas anak wajib diisi untuk orang tua.");
  if (role === "orangtua" && !parentAbsen) return toast("No absen siswa wajib diisi untuk orang tua.");
  if (role === "guru" && isWaliKelas && !waliKelas) return toast("Kelas wali wajib diisi kalau guru dijadikan wali kelas.");
  if (role === "guru" && !mengajar.length) return toast("Isi kelas yang diajar guru.");

  if (role === "siswa") {
    if (!siswaNik || !siswaNama || !siswaKelas) return toast("NIK, nama, dan kelas siswa wajib diisi.");
    setLoading(true, editIndex === "STUDENT" ? "Update siswa..." : "Menyimpan siswa...");
    try {
      await upsertStudentFromAdminForm({ nik: siswaNik, nisn: siswaNisn, nis: siswaNis, nama: siswaNama, kelas: siswaKelas, jenis: siswaJenis || "L", agama: siswaAgama || "Islam" });
      resetAccountForm();
      renderAll();
      toast("Data siswa berhasil disimpan.");
    } catch(e) { toast(e.message || "Gagal simpan siswa."); } finally { setLoading(false); }
    return;
  }

  const duplicate = accountsDB.findIndex(a => a.username.toLowerCase() === username.toLowerCase());
  if (duplicate >= 0 && String(duplicate) !== String(editIndex)) {
    return toast("Username sudah dipakai.");
  }

  const account = applyAccountRules({
    username,
    password,
    role,
    displayName: displayName || username,
    kelas: role === "orangtua" ? (kelas || null) : null,
    parentAbsen,
    parentPhone,
    isWaliKelas,
    waliKelas,
    nip,
    mengajar
  });
  if (editIndex === "") accountsDB.push(account);
  else accountsDB[Number(editIndex)] = account;

  if (!accountsDB.some(a => a.role === "admin")) {
    return toast("Minimal harus ada 1 akun admin.");
  }

  saveAccountsCache();
  setLoading(true, "Menyimpan akun...");
  try {
    await saveAccountsToFirestore();
    resetAccountForm();
    renderAccounts();
    toast(editIndex === "" ? "Akun berhasil ditambahkan." : "Akun berhasil diperbarui.");
  } catch (e) {
    toast("Gagal simpan akun: " + e.message);
  } finally {
    setLoading(false);
  }
}

async function deleteAccount(index){
  if (session.role !== "admin") return toast("Hanya admin yang bisa menghapus akun.");
  const acc = accountsDB[index];
  if (!acc) return;
  const adminCount = accountsDB.filter(a => a.role === "admin").length;
  if (acc.role === "admin" && adminCount <= 1) return toast("Minimal 1 admin harus ada.");
  if (!confirm(`Hapus akun @${acc.username}?`)) return;
  accountsDB.splice(index, 1);
  saveAccountsCache();
  setLoading(true, "Menghapus akun...");
  try {
    await saveAccountsToFirestore();
    if ($("acc-edit-index")?.value === String(index)) resetAccountForm();
    renderAccounts();
    toast("Akun berhasil dihapus.");
  } catch (e) {
    toast("Gagal hapus akun: " + e.message);
  } finally {
    setLoading(false);
  }
}

function emptyPicketSchedule(){
  return { senin: [], selasa: [], rabu: [], kamis: [], jumat: [], sabtu: [] };
}

function lessonStorageKey(){ return "ABSEN_PELAJARAN_DB"; }
function picketStorageKey(){ return "ABSEN_PIKET_SCHEDULE"; }

function restorePicketScheduleCache(){
  const raw = localStorage.getItem(picketStorageKey());
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    picketScheduleDB = { ...emptyPicketSchedule(), ...(parsed || {}) };
  } catch {
    picketScheduleDB = emptyPicketSchedule();
  }
  localStorage.setItem(picketStorageKey(), JSON.stringify(picketScheduleDB));
}

function savePicketScheduleCache(){
  localStorage.setItem(picketStorageKey(), JSON.stringify(picketScheduleDB || emptyPicketSchedule()));
}

async function loadPicketScheduleFromFirestore(){
  try {
    const db = firebase.firestore();
    const doc = await db.collection("settings").doc("picketSchedule").get();
    if (doc.exists) {
      picketScheduleDB = { ...emptyPicketSchedule(), ...(doc.data()?.days || {}) };
      savePicketScheduleCache();
    } else {
      await savePicketScheduleToFirestore();
    }
  } catch(e){ console.error("loadPicketSchedule", e); }
}
async function loadTeacherAttendanceFromFirestore(){
  try {
    const db = firebase.firestore();
    const snapshot = await db.collection("teacherAttendance").get();
    teacherAttendanceDB = [];
    snapshot.forEach(doc => {
      const data = doc.data() || {};
      teacherAttendanceDB.push({
        id: data.id || doc.id,
        date: data.date || "-",
        teacherUsername: data.teacherUsername || "-",
        teacherName: data.teacherName || data.teacherUsername || "-",
        kelas: data.kelas || "-",
        createdAt: Number(data.createdAt || Date.now()),
        records: data.records || {}
      });
    });
    saveTeacherAttendanceCache();
  } catch(e){ console.error("loadTeacherAttendance", e); }
}


async function savePicketScheduleToFirestore(){
  const db = firebase.firestore();
  await db.collection("settings").doc("picketSchedule").set({ days: picketScheduleDB || emptyPicketSchedule(), updatedAt: Date.now() }, { merge: true });
}

function lessonWeekday(){
  const days = ["minggu","senin","selasa","rabu","kamis","jumat","sabtu"];
  return days[new Date().getDay()];
}

function teacherCanUsePelajaran(){
  return session.role === "guru";
}

function teachersForScheduling(){
  return accountsDB.filter(a => a.role === "guru");
}

function isScheduledPicketToday(username){
  const day = lessonWeekday();
  const arr = (picketScheduleDB && picketScheduleDB[day]) || [];
  return arr.includes(String(username || "").trim());
}

function renderPicketScheduleAdmin(){
  const wrap = $("picket-schedule-wrap");
  if (!wrap) return;
  const teachers = teachersForScheduling();
  const days = ["senin","selasa","rabu","kamis","jumat","sabtu"];
  wrap.innerHTML = days.map(day => {
    const checked = new Set((picketScheduleDB && picketScheduleDB[day]) || []);
    const items = teachers.length ? teachers.map(t => `
      <label class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-200 bg-gray-900/60 rounded-xl px-3 py-2">
        <input type="checkbox" class="picket-day-check accent-cyan-500" data-day="${day}" value="${t.username}" ${checked.has(t.username) ? "checked" : ""}/>
        <span>${t.displayName || t.username}${t.isWaliKelas && t.waliKelas ? ` • WALI ${t.waliKelas}` : ""}</span>
      </label>`).join("") : '<div class="text-[10px] text-gray-500 uppercase font-bold">Belum ada akun guru.</div>';
    return `
      <div class="glass p-4 rounded-[1.75rem]">
        <div class="text-[10px] font-black uppercase tracking-widest text-yellow-300 mb-3">${day}</div>
        <div class="grid md:grid-cols-2 gap-2">${items}</div>
      </div>`;
  }).join("");
}

async function savePicketScheduleFromForm(){
  if (session.role !== "admin") return toast("Hanya admin yang bisa atur jadwal piket.");
  const next = emptyPicketSchedule();
  document.querySelectorAll(".picket-day-check").forEach(ch => {
    const day = ch.getAttribute("data-day");
    if (ch.checked && next[day]) next[day].push(ch.value);
  });
  picketScheduleDB = next;
  savePicketScheduleCache();
  setLoading(true, "Menyimpan jadwal piket...");
  try {
    await savePicketScheduleToFirestore();
    session.piketToday = isScheduledPicketToday(session.username);
    showRoleView();
    toast("Jadwal piket berhasil disimpan.");
  } catch(e){
    toast("Gagal simpan jadwal piket: " + e.message);
  } finally { setLoading(false); }
}

function restoreTeacherAttendanceCache(){
  const raw = localStorage.getItem(lessonStorageKey());
  try { teacherAttendanceDB = raw ? JSON.parse(raw) : []; } catch { teacherAttendanceDB = []; }
}

function saveTeacherAttendanceCache(){
  localStorage.setItem(lessonStorageKey(), JSON.stringify(teacherAttendanceDB));
}

function currentLessonSession(){
  return teacherAttendanceDB.find(x => x.id === currentLessonSessionId) || null;
}

function teacherLessonDateId(){ return todayId(); }

function newLessonSessionId(){ return `LESSON_${Date.now()}_${Math.random().toString(36).slice(2,8)}`; }

async function upsertTeacherSessionToFirestore(sessionDoc){
  try {
    const db = firebase.firestore();
    await db.collection("teacherAttendance").doc(sessionDoc.id).set(sessionDoc, { merge: true });
  } catch(e) { console.error("upsertTeacherSession", e); }
}

function currentSelectedLessonClass(){
  return String($("pelajaran-kelas")?.value || "").trim();
}

async function startLessonSession(){
  if (!teacherCanUsePelajaran()) return toast("Akses tab pelajaran ditolak.");
  const kelas = currentSelectedLessonClass();
  if (!kelas) return toast("Pilih kelas dulu.");
  const doc = {
    id: newLessonSessionId(),
    date: teacherLessonDateId(),
    teacherUsername: session.username,
    teacherName: session.displayName || session.username,
    kelas,
    createdAt: Date.now(),
    records: {}
  };
  teacherAttendanceDB.push(doc);
  currentLessonSessionId = doc.id;
  saveTeacherAttendanceCache();
  await upsertTeacherSessionToFirestore(doc);
  renderAll();
  toast(`Absensi kelas ${kelas} dimulai.`);
}

function teacherSessionsFor(username, dateId = null){
  return teacherAttendanceDB.filter(x => x.teacherUsername === username && (!dateId || x.date === dateId));
}

async function markLessonAttendance({ kelas, absen, status, source = "MANUAL" }){
  const active = currentLessonSession();
  if (!active) return { ok:false, msg:"Mulai absensi kelas dulu." };
  if (active.kelas !== kelas) return { ok:false, msg:`Absensi aktif untuk ${active.kelas}, bukan ${kelas}.` };
  const student = (localDB[kelas] || []).find(s => normalizeAbsen(s.Absen) === normalizeAbsen(absen));
  if (!student) return { ok:false, msg:"Siswa tidak ditemukan." };
  active.records[normalizeAbsen(absen)] = {
    Nama: student.Nama,
    Kelas: student.Kelas,
    Absen: normalizeAbsen(student.Absen),
    JK: student.JK || "-",
    Agama: student.Agama || "-",
    Status: status || "HADIR",
    Jam: nowTimeId(),
    Tanggal: active.date,
    Guru: active.teacherName,
    Sumber: source
  };
  saveTeacherAttendanceCache();
  upsertTeacherSessionToFirestore(active);
  return { ok:true, student, msg:"OK" };
}

function lessonRowsForSession(sessionDoc){
  return Object.values(sessionDoc?.records || {}).sort((a,b) => Number(a.Absen) - Number(b.Absen)).map((r,idx) => ({
    No: idx + 1,
    Tanggal: sessionDoc.date,
    Guru: sessionDoc.teacherName,
    Kelas: sessionDoc.kelas,
    Absen: r.Absen,
    Nama: safeUpper(r.Nama),
    JK: r.JK || "-",
    Agama: r.Agama || "-",
    Status: r.Status || "-",
    Jam: r.Jam || "-",
    Sumber: r.Sumber || "-"
  }));
}

function groupedTeacherLessonRows(username, dateId = null){
  const grouped = {};
  teacherSessionsFor(username, dateId).forEach(sess => {
    const rows = lessonRowsForSession(sess);
    if (!rows.length) return;
    if (!grouped[sess.kelas]) grouped[sess.kelas] = [];
    grouped[sess.kelas].push(...rows);
  });
  return grouped;
}

async function exportTeacherLessonZip(kind = "daily"){
  if (!teacherCanUsePelajaran()) return toast("Akses tab pelajaran ditolak.");
  const zip = new JSZip();
  const dateId = teacherLessonDateId();
  const grouped = groupedTeacherLessonRows(session.username, kind === "daily" ? dateId : null);
  const kelasList = Object.keys(grouped).sort();
  if (!kelasList.length) return toast(kind === "daily" ? "Belum ada absensi pelajaran hari ini." : "Belum ada rekap absensi pelajaran.");
  setLoading(true, kind === "daily" ? "Membuat ZIP pelajaran harian..." : "Membuat ZIP rekap pelajaran...");
  try {
    kelasList.forEach(kelas => {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(grouped[kelas]);
      XLSX.utils.book_append_sheet(wb, ws, kelas.slice(0,31));
      const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const prefix = kind === "daily" ? "PELAJARAN_HARIAN" : "PELAJARAN_REKAP";
      zip.file(`${kelas}/${prefix}_${kelas}.xlsx`, arr);
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const safeName = (session.displayName || session.username || "guru").replace(/[^a-z0-9_-]+/ig, "-");
    const fileName = kind === "daily" ? `PELAJARAN_HARIAN_${safeName}_${dateId.replace(/\//g, "-")}.zip` : `PELAJARAN_REKAP_${safeName}.zip`;
    downloadBlobFile(blob, fileName);
    toast(`ZIP ${kind === "daily" ? "harian" : "rekap"} berhasil dibuat.`);
  } catch(e){
    console.error(e);
    toast("Gagal export pelajaran: " + e.message);
  } finally { setLoading(false); }
}

function renderLessonStudentList(){
  const el = $("pelajaran-student-list");
  if (!el) return;
  const active = currentLessonSession();
  const kelas = active?.kelas || currentSelectedLessonClass();
  if (!kelas) {
    el.innerHTML = '<p class="text-center text-gray-500 py-8 text-[10px] uppercase font-bold">Pilih kelas lalu mulai absensi.</p>';
    return;
  }
  const query = String($("pelajaran-search")?.value || "").trim().toLowerCase();
  let students = (localDB[kelas] || []).slice().sort((a,b) => Number(a.Absen) - Number(b.Absen));
  if (query) students = students.filter(s => `${s.Nama} ${s.Absen}`.toLowerCase().includes(query));
  if (!students.length) {
    el.innerHTML = '<p class="text-center text-gray-500 py-8 text-[10px] uppercase font-bold">Belum ada siswa di kelas ini.</p>';
    return;
  }
  const activeRecords = active?.records || {};
  el.innerHTML = students.map(s => {
    const rec = activeRecords[normalizeAbsen(s.Absen)];
    const status = rec?.Status || '-';
    const mkBtn = (st,label,cls) => `<button class="lesson-mark-btn ${cls}" data-absen="${s.Absen}" data-status="${st}">${label}</button>`;
    return `
      <div class="glass p-4 rounded-2xl">
        <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <div class="text-xs font-black text-white uppercase">${safeUpper(s.Nama)}</div>
            <div class="text-[9px] text-gray-500 uppercase font-bold">${kelas} • ABSEN ${s.Absen} • STATUS: <span class="text-cyan-300">${status}</span></div>
          </div>
          <div class="flex flex-wrap gap-2">
            ${mkBtn('HADIR','Hadir','bg-emerald-700 hover:bg-emerald-600')}
            ${mkBtn('ALPA','Alpa','bg-red-700 hover:bg-red-600')}
            ${mkBtn('SAKIT','Sakit','bg-yellow-700 hover:bg-yellow-600')}
            ${mkBtn('IZIN','Izin','bg-blue-700 hover:bg-blue-600')}
            ${mkBtn('DISPEN','Dispen','bg-purple-700 hover:bg-purple-600')}
          </div>
        </div>
      </div>`;
  }).join('');
  el.querySelectorAll('.lesson-mark-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const res = await markLessonAttendance({ kelas, absen: btn.getAttribute('data-absen'), status: btn.getAttribute('data-status'), source: 'MANUAL' });
      if (!res.ok) return toast(res.msg);
      renderAll();
    });
  });
}

function renderLessonTodaySessions(){
  const el = $("pelajaran-session-list");
  if (!el) return;
  const list = teacherSessionsFor(session.username, teacherLessonDateId()).sort((a,b) => b.createdAt - a.createdAt);
  if (!list.length) {
    el.innerHTML = '<p class="text-center text-gray-500 py-8 text-[10px] uppercase font-bold">Belum ada absensi pelajaran hari ini.</p>';
    return;
  }
  el.innerHTML = list.map(sess => {
    const total = Object.keys(sess.records || {}).length;
    return `
      <button class="lesson-session-item w-full text-left glass p-4 rounded-2xl hover:border-cyan-500/40 transition-all ${sess.id === currentLessonSessionId ? 'border border-cyan-500/40' : ''}" data-id="${sess.id}">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-xs font-black text-white uppercase">${sess.kelas}</div>
            <div class="text-[9px] text-gray-500 uppercase font-bold">${sess.date} • ${new Date(sess.createdAt).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})} • ${total} siswa</div>
          </div>
          <div class="text-[10px] font-black uppercase tracking-widest text-cyan-300">${sess.id === currentLessonSessionId ? 'AKTIF' : 'BUKA'}</div>
        </div>
      </button>`;
  }).join('');
  el.querySelectorAll('.lesson-session-item').forEach(btn => {
    btn.addEventListener('click', () => {
      currentLessonSessionId = btn.getAttribute('data-id');
      const sess = currentLessonSession();
      if (sess && $("pelajaran-kelas")) $("pelajaran-kelas").value = sess.kelas;
      renderAll();
    });
  });
}

function renderPelajaranPanel(){
  const wrap = $("view-pelajaran");
  if (!wrap) return;
  if (!teacherCanUsePelajaran()) { wrap.classList.add("hidden"); return; }
  const sel = $("pelajaran-kelas");
  if (sel && !sel.dataset.ready) {
    const kelasOpts = (Array.isArray(session.mengajar) && session.mengajar.length) ? session.mengajar : [];
    sel.innerHTML = '<option value="">Pilih kelas...</option>' + kelasOpts.map(k => `<option value="${k}">${k}</option>`).join('');
    sel.dataset.ready = '1';
  }
  const active = currentLessonSession();
  setText("pelajaran-active-info", active ? `Absensi aktif: ${active.kelas} • ${Object.keys(active.records || {}).length} siswa` : 'Belum ada absensi aktif. Pilih kelas lalu klik Mulai Absensi.');
  renderLessonTodaySessions();
  renderLessonStudentList();
}

/* ===================== HELPERS ===================== */
function $(id){ return document.getElementById(id); }
function show(id){ $(id)?.classList.remove("hidden"); }
function hide(id){ $(id)?.classList.add("hidden"); }
function setText(id, t){ const el = $(id); if(el) el.textContent = t; }
function toast(msg, isError = true) {
  const existing = document.getElementById("custom-toast");
  if (existing) existing.remove();

  const div = document.createElement("div");
  div.id = "custom-toast";
  div.className = "fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] px-6 py-4 rounded-2xl shadow-2xl text-white font-bold text-xs uppercase tracking-widest transition-all duration-300 " + (isError ? "bg-red-600" : "bg-emerald-600");
  div.textContent = msg;
  document.body.appendChild(div);

  // Hilang otomatis setelah 3 detik
  setTimeout(() => {
    if (div && div.parentNode) div.remove();
  }, 3000);
}

function setLoading(on, text) {
  const ov = document.getElementById("loading-overlay");
  if (!ov) return;
  
  // Bersihkan timer lama
  if (window.loadingTimer) {
    clearTimeout(window.loadingTimer);
    window.loadingTimer = null;
  }

  if (on) {
    if (text) document.getElementById("loading-text").textContent = text;
    ov.classList.remove("hidden");
    
    // SAFETY NET: Jika loading tidak dimatikan manual selama 8 detik, matikan paksa
    window.loadingTimer = setTimeout(() => {
      ov.classList.add("hidden");
      console.warn("Loading force closed karena timeout");
    }, 8000);
  } else {
    ov.classList.add("hidden");
  }
}

function todayId(){
  return new Date().toLocaleDateString("id-ID");
}

function nowTimeId(){
  return new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

function safeUpper(s){
  return String(s || "").toUpperCase();
}

function normalizeAbsen(a){
  return String(a ?? "").trim().padStart(2, "0");
}

function ensureBuckets(){
  DAFTAR_KELAS.forEach(k => {
    if (!Array.isArray(localDB[k])) localDB[k] = [];
  });
}

function normalizeClassTokenV4(value){
  let v = String(value || '').trim().toUpperCase();
  if (!v) return '';
  v = v.replace(/_/g, '-').replace(/\s+/g, '');
  v = v.replace(/^XII(\d+)$/, 'XII-$1');
  v = v.replace(/^XI(\d+)$/, 'XI-$1');
  v = v.replace(/^X(\d+)$/, 'X-$1');
  v = v.replace(/^XII-?(\d+)$/, 'XII-$1');
  v = v.replace(/^XI-?(\d+)$/, 'XI-$1');
  v = v.replace(/^X-?(\d+)$/, 'X-$1');
  return v;
}

function normalizeClassName(kelas){
  return normalizeClassTokenV4(kelas);
}

function normalizeNik(v){
  return String(v || '').trim();
}

function findStudentByNik(nik){
  const needle = normalizeNik(nik);
  if (!needle) return null;
  for (const kelas of DAFTAR_KELAS) {
    const found = (localDB[kelas] || []).find(s => normalizeNik(s.NIK) === needle);
    if (found) return found;
  }
  return null;
}

function nextAbsenForClass(kelas){
  const arr = (localDB[kelas] || []);
  const nums = arr.map(s => parseInt(String(s.Absen || '').replace(/^0+/, '') || '0', 10)).filter(n => !Number.isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return normalizeAbsen(String(next));
}

function makeQrPayload({ nama, kelas, absen, jk, agama, nik }){
  const nikFix = normalizeNik(nik);
  if (nikFix) return nikFix;
  return `${nama}|${kelas}|${absen}|${jk}|${agama}`;
}

function parsePayload(text){
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (!raw.includes('|')) {
    const student = findStudentByNik(raw);
    if (!student) return null;
    return {
      nama: student.Nama?.trim(),
      kelas: student.Kelas?.trim(),
      absen: normalizeAbsen(student.Absen),
      jk: (student.JK || student.Jenis || '-').trim(),
      agama: (student.Agama || '-').trim(),
      nik: normalizeNik(student.NIK),
      student
    };
  }
  const parts = raw.split('|');
  if (parts.length < 5) return null;
  const [nama, kelas, absen, jk, agama] = parts;
  return {
    nama: nama?.trim(),
    kelas: kelas?.trim(),
    absen: normalizeAbsen(absen),
    jk: jk?.trim(),
    agama: agama?.trim(),
    nik: null,
    student: null
  };
}

function saveSession(){
  localStorage.setItem("ABSEN_SESSION", JSON.stringify(session));
}

function restoreSession(){
  const raw = localStorage.getItem("ABSEN_SESSION");
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    if (s && ["admin", "guru", "orangtua"].includes(s.role)) {
      session = { ...session, ...s };
    }
  } catch {}
}

function saveCacheDB(){
  localStorage.setItem("ABSEN_CACHE_DB", JSON.stringify(localDB));
}

function restoreCacheDB(){
  const raw = localStorage.getItem("ABSEN_CACHE_DB");
  if (!raw) return;
  try {
    localDB = JSON.parse(raw) || {};
  } catch {
    localDB = {};
  }
}

function dailyKeyForDate(tanggal){
  return `ABSEN_DAILY_EVENTS_${String(tanggal || todayId())}`;
}

function emptyDailyEvents(){
  return { dispen: {}, pulangCepat: {}, terlambat: {} };
}

function dailyKey(){
  return dailyKeyForDate(todayId());
}

function getDailyEventsForDate(tanggal){
  const raw = localStorage.getItem(dailyKeyForDate(tanggal));
  if (!raw) return emptyDailyEvents();
  try {
    const parsed = JSON.parse(raw);
    return {
      dispen: parsed?.dispen || {},
      pulangCepat: parsed?.pulangCepat || {},
      terlambat: parsed?.terlambat || {}
    };
  } catch {
    return emptyDailyEvents();
  }
}

function getDailyEvents(){
  return getDailyEventsForDate(todayId());
}

function saveDailyEventsForDate(tanggal, obj){
  const next = {
    dispen: obj?.dispen || {},
    pulangCepat: obj?.pulangCepat || {},
    terlambat: obj?.terlambat || {}
  };
  localStorage.setItem(dailyKeyForDate(tanggal), JSON.stringify(next));
}

function saveDailyEvents(obj){
  saveDailyEventsForDate(todayId(), obj);
}

function clearLocalDailyEvents(){
  const prefix = 'ABSEN_DAILY_EVENTS_';
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) keys.push(key);
  }
  keys.forEach(key => localStorage.removeItem(key));
}

function studentKey(kelas, absen){
  return `${kelas}#${normalizeAbsen(absen)}`;
}

function normalizeStudentRow(row){
  const out = {
    NIK: normalizeNik(row.NIK),
    NISN: String(row.NISN || '-').trim(),
    NIS: String(row.NIS || '-').trim(),
    Nama: row.Nama,
    Kelas: normalizeClassName(row.Kelas),
    Absen: normalizeAbsen(row.Absen),
    Jenis: row.Jenis || row.JK || '-',
    JK: row.JK || row.Jenis || '-',
    Agama: row.Agama || '-',
    NoHP: String(row.NoHP || '-').trim(),
    Jam: (row.Jam && row.Jam !== '-') ? String(row.Jam).replace(/\./g, ':') : '-',
    JamTerlambat: (row.JamTerlambat && row.JamTerlambat !== '-') ? String(row.JamTerlambat).replace(/\./g, ':') : '-',
    Tanggal: patchNormalizeDateId(row.Tanggal) || '-',
    Status: row.Status || '-',
    Hadir: Number(row.Hadir || 0),
    Sakit: Number(row.Sakit || 0),
    Izin: Number(row.Izin || 0),
    Alpa: Number(row.Alpa || 0),
    Terlambat: Number(row.Terlambat || 0),
    Dispen: Number(row.Dispen || 0),
    PulangCepat: Number(row.PulangCepat || 0),
    Catatan: row.Catatan || '-'
  };
  return out;
}

function migrateStudentsSchema(){
  DAFTAR_KELAS.forEach(k => {
    localDB[k] = (localDB[k] || []).map(normalizeStudentRow);
  });
}

function normalizePhone(phone){
  return String(phone || "").replace(/\D/g, "");
}

function findStudentByKelasAbsen(kelas, absen){
  return (localDB[kelas] || []).find(s => normalizeAbsen(s.Absen) === normalizeAbsen(absen)) || null;
}

function getParentStudent(){
  if (session.role !== "orangtua") return null;
  if (!session.kelas || !session.parentAbsen) return null;
  return findStudentByKelasAbsen(session.kelas, session.parentAbsen);
}

function isParentNotifEnabled() {
  return localStorage.getItem("PARENT_NOTIF_ENABLED") === "1";
}

async function persistParentNotificationToken(token) {
  if (!token || session.role !== "orangtua") return;
  try {
    const db = firebase.firestore();
    await db.collection("notificationTokens").doc(session.username).set({
      username: session.username,
      role: session.role,
      kelas: session.kelas || null,
      parentAbsen: session.parentAbsen || null,
      parentPhone: session.parentPhone || null,
      tokens: firebase.firestore.FieldValue.arrayUnion(token),
      updatedAt: new Date().toISOString()
    }, { merge: true });
    localStorage.setItem("PARENT_NOTIF_TOKEN", token);
  } catch (err) {
    console.error("Gagal simpan token notif:", err);
  }
}

async function enableParentNotification() {
  try {
    if (session.role !== "orangtua") {
      return toast("Login sebagai orang tua dulu.");
    }

    if (!("Notification" in window)) {
      return toast("Browser tidak support notifikasi.");
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return toast("Izin notifikasi ditolak.");
    }

    let swRegistration = null;
    if ("serviceWorker" in navigator) {
      swRegistration = await navigator.serviceWorker.register("./sw.js");
    }

    try {
      const VAPID_KEY = "BDZSeqo1eBgE_SMbeTGdl7_63bn4BRTIHpiNaoQKuy1XKnF_n21MvXTNTlzR-cxqf40KZz-EEvgg6cdaNpD_gww";
      const token = await firebase.messaging().getToken({
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swRegistration || undefined
      });
      console.log("FCM Token:", token);
      await persistParentNotificationToken(token);
      localStorage.setItem("PARENT_NOTIF_ENABLED", "1");
    } catch (err) {
      console.error("Gagal dapetin token:", err);
      localStorage.setItem("PARENT_NOTIF_ENABLED", "1");
    }

    lastParentStatusKey = "";
    setText("ortu-notif-info", "Notifikasi realtime aktif di device ini ✅");
    toast("Notifikasi berhasil diaktifkan ✅");
    startParentWatcher();
  } catch (err) {
    console.error(err);
    toast("Gagal aktifkan notif.");
  }
}

function buildParentStatusKey(student, daily) {
  if (!student) return "";
  const skey = studentKey(student.Kelas, student.Absen);
  const terlambat = daily?.terlambat?.[skey] || "-";
  const dispen = daily?.dispen?.[skey]
    ? `${daily.dispen[skey].out || "-"}-${daily.dispen[skey].back || "-"}`
    : "-";
  const pulang = daily?.pulangCepat?.[skey]?.time || "-";
  return [
    student.Tanggal || "-",
    student.Status || "-",
    student.Jam || "-",
    terlambat,
    dispen,
    pulang,
    student.Catatan || "-"
  ].join("|");
}

function getNotifText(student, daily) {
  const skey = studentKey(student.Kelas, student.Absen);
  const dispenData = daily?.dispen?.[skey];
  const pulangData = daily?.pulangCepat?.[skey];
  const terlambatJam = daily?.terlambat?.[skey] || "-";
  
  let title = CONFIG.SCHOOL_NAME;
  let body = `${student.Nama} (${student.Kelas} - ${student.Absen})`;
  
  // PRIORITAS 1: CEK DISPEN (KELUAR ATAU BALIK)
  if (dispenData) {
    if (dispenData.back && dispenData.back !== "-") {
      // UDAH BALIK DARI DISPEN
      title = `↩️ ${CONFIG.SCHOOL_NAME}`;
      body = `${student.Nama} kembali dari dispen pukul ${dispenData.back}`;
    } else {
      // DISPEN KELUAR
      title = `⏱️ ${CONFIG.SCHOOL_NAME}`;
      body = `${student.Nama} keluar (dispen) pukul ${dispenData.out}`;
      if (dispenData.alasan && dispenData.alasan !== "-") {
        body += `\nAlasan: ${dispenData.alasan}`;
      }
    }
    return { title, body }; // <-- LANGSUNG RETURN
  }
  
  // PRIORITAS 2: CEK PULANG CEPAT
  if (pulangData) {
    title = `🏃 ${CONFIG.SCHOOL_NAME}`;
    body = `${student.Nama} pulang cepat pukul ${pulangData.time}`;
    if (pulangData.alasan && pulangData.alasan !== "-") {
      body += `\nAlasan: ${pulangData.alasan}`;
    }
    return { title, body }; // <-- LANGSUNG RETURN
  }
  
  // PRIORITAS 3: STATUS BIASA (HADIR/IZIN/SAKIT/ALPA)
  if (student.Status === "HADIR") {
    if (terlambatJam !== "-" && terlambatJam) {
      title = `⚠️ ${CONFIG.SCHOOL_NAME}`;
      body = `${student.Nama} terlambat pukul ${student.Jam}`;
    } else {
      title = `✅ ${CONFIG.SCHOOL_NAME}`;
      body = `${student.Nama} hadir pukul ${student.Jam}`;
    }
  } else if (student.Status === "IZIN") {
    title = `📝 ${CONFIG.SCHOOL_NAME}`;
    body = `${student.Nama} izin`;
    if (student.Catatan && student.Catatan !== "-") {
      body += `\nAlasan: ${student.Catatan}`;
    }
  } else if (student.Status === "SAKIT") {
    title = `🤒 ${CONFIG.SCHOOL_NAME}`;
    body = `${student.Nama} sakit`;
    if (student.Catatan && student.Catatan !== "-") {
      body += `\nAlasan: ${student.Catatan}`;
    }
  } else if (student.Status === "ALPA") {
    title = `❌ ${CONFIG.SCHOOL_NAME}`;
    body = `${student.Nama} alpa (tanpa keterangan)`;
  }
  
  return { title, body };
}

async function showParentNotification(title, body) {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    
    // Opsi notifikasi HEADS-UP (gede di HP)
    const options = {
      body: body,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      image: "./icon-512.png", // <-- GAMBAR BESAR (opsional)
      vibrate: [500, 250, 500], // <-- GETAR PANJANG biar perhatian
      silent: false,
      requireInteraction: true, // <-- TIDAK ILANG OTOMATIS
      tag: 'presensi-notification', // <-- BIAR GAK DOBEL
      renotify: true,
      actions: [
        {
          action: 'open',
          title: 'Buka Aplikasi'
        },
        {
          action: 'close',
          title: 'Tutup'
        }
      ]
    };
    
    // TAMBAHIN DATA KHUSUS ANDROID (biar HEADS-UP)
    if ('actions' in Notification.prototype) {
      options.actions = [
        {
          action: 'open',
          title: '🔍 Lihat Detail'
        },
        {
          action: 'close',
          title: '✖ Tutup'
        }
      ];
    }
    
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) {
      await registration.showNotification(title, options);
    } else {
      new Notification(title, options);
    }
    
    console.log("✅ Notifikasi HEADS-UP terkirim:", title, body);
  } catch (err) {
    console.error("❌ Notif gagal:", err);
  }
}

function stopParentWatcher() {
  if (parentWatchInterval) {
    clearInterval(parentWatchInterval);
    parentWatchInterval = null;
  }
  lastParentStatusKey = "";
}

async function checkParentStatusChange() {
  try {
    if (session.role !== "orangtua") return;
    if (!isParentNotifEnabled()) return;
    const student = getParentStudent();
    if (!student) return;
    const daily = getDailyEvents();
    const currentKey = buildParentStatusKey(student, daily);
    if (!lastParentStatusKey) {
      lastParentStatusKey = currentKey;
      renderOrtuDashboard();
      return;
    }
    if (currentKey !== lastParentStatusKey) {
      lastParentStatusKey = currentKey;
      renderOrtuDashboard();
      const notif = getNotifText(student, daily);
      await showParentNotification(notif.title, notif.body);
    }
  } catch (err) {
    console.error("Watcher notif error:", err);
  }
}

function startParentWatcher() {
  stopParentWatcher();
  if (session.role !== "orangtua") return;
  if (!isParentNotifEnabled()) return;
  checkParentStatusChange();
  parentWatchInterval = setInterval(checkParentStatusChange, 10000);
}

/* ===================== FIRESTORE ===================== */
async function deleteSnapshotDocs(snapshot, db) {
  if (!snapshot || snapshot.empty) return;
  let batch = db.batch();
  let count = 0;
  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
    count += 1;
    if (count >= 400) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

async function clearDailyEventsFromFirestore() {
  try {
    const db = firebase.firestore();
    const daysSnapshot = await db.collection("dailyEvents").get();
    for (const dayDoc of daysSnapshot.docs) {
      await deleteSnapshotDocs(await dayDoc.ref.collection("dispen").get(), db);
      await deleteSnapshotDocs(await dayDoc.ref.collection("pulangCepat").get(), db);
      await deleteSnapshotDocs(await dayDoc.ref.collection("terlambat").get(), db);
      await dayDoc.ref.delete().catch(() => null);
    }
  } catch (e) {
    console.error("Gagal menghapus daily events:", e);
    throw e;
  }
}

async function deleteStudentDailyEventsFromFirestore(kelas, absen) {
  try {
    const db = firebase.firestore();
    const skey = studentKey(kelas, absen);
    const daysSnapshot = await db.collection("dailyEvents").get();
    let batch = db.batch();
    let count = 0;
    for (const dayDoc of daysSnapshot.docs) {
      ["dispen", "pulangCepat", "terlambat"].forEach(sub => {
        batch.delete(dayDoc.ref.collection(sub).doc(skey));
        count += 1;
      });
      if (count >= 390) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
    if (count > 0) await batch.commit();
  } catch (e) {
    console.error("Gagal hapus daily event siswa:", e);
  }
}

function bindDailyEventSnapshot(tanggal, type, snapshot) {
  const daily = getDailyEventsForDate(tanggal);
  if (type === "dispen") daily.dispen = {};
  if (type === "pulangCepat") daily.pulangCepat = {};
  if (type === "terlambat") daily.terlambat = {};

  snapshot.forEach(doc => {
    if (type === "dispen") daily.dispen[doc.id] = doc.data();
    if (type === "pulangCepat") daily.pulangCepat[doc.id] = doc.data();
    if (type === "terlambat") daily.terlambat[doc.id] = doc.data().jam || "-";
  });

  saveDailyEventsForDate(tanggal, daily);
  renderAll();
  checkParentStatusChange().catch(console.error);
}

async function subscribeToDailyEvents(tanggal) {
  if (!tanggal) return;
  const db = firebase.firestore();
  const map = {
    dailyDispen: "dispen",
    dailyPulangCepat: "pulangCepat",
    dailyTerlambat: "terlambat"
  };
  Object.entries(map).forEach(([key, type]) => {
    if (unsubscribers[key]) unsubscribers[key]();
    unsubscribers[key] = db.collection("dailyEvents").doc(tanggal).collection(type)
      .onSnapshot(snapshot => bindDailyEventSnapshot(tanggal, type, snapshot), error => {
        console.error(`Error subscribe ${type}:`, error);
      });
  });
}

async function subscribeToKelas(kelas) {
  if (!kelas) return;
  const db = firebase.firestore();
  
  if (unsubscribers[kelas]) {
    unsubscribers[kelas]();
  }
  
  unsubscribers[kelas] = db.collection("kelas").doc(kelas).collection("siswa")
    .onSnapshot((snapshot) => {
      localDB[kelas] = [];
      snapshot.forEach(doc => {
        localDB[kelas].push(normalizeStudentRow(doc.data()));
      });
      localDB[kelas] = sortStudentsAlpha(localDB[kelas] || []);
      saveCacheDB();
      renderAll();
      checkParentStatusChange().catch(console.error);
    }, (error) => {
      console.error(`Error subscribe kelas ${kelas}:`, error);
    });
}

async function subscribeToAllClasses() {
  for (const kelas of DAFTAR_KELAS) {
    await subscribeToKelas(kelas);
  }
  
  const db = firebase.firestore();
  if (unsubscribers.settings) unsubscribers.settings();
  unsubscribers.settings = db.collection("settings").doc("global")
    .onSnapshot((doc) => {
      if (doc.exists) {
        settings = { ...settings, ...doc.data() };
        if ($("set-late")) $("set-late").value = settings.lateCutoff;
        if ($("set-alpa")) $("set-alpa").value = settings.alpaCutoff;
      }
    });
  await subscribeToDailyEvents(todayId());
}

async function loadAllFromFirestore() {
  setLoading(true, "Sinkronisasi Database..."); // <-- LOADING TETEP ADA
  try {
    const db = firebase.firestore();
    for (const kelas of DAFTAR_KELAS) {
      const snapshot = await db.collection("kelas").doc(kelas).collection("siswa").get();
      localDB[kelas] = [];
      snapshot.forEach(doc => {
        localDB[kelas].push(normalizeStudentRow(doc.data()));
      });
    }
    
    const settingsDoc = await db.collection("settings").doc("global").get();
    if (settingsDoc.exists) {
      settings = { ...settings, ...settingsDoc.data() };
    }

    await loadAccountsFromFirestore();
    await loadPicketScheduleFromFirestore();
    await loadTeacherAttendanceFromFirestore();
    
    ensureBuckets();
    migrateStudentsSchema();
    resequenceAllClasses();
    saveCacheDB();
    
    await subscribeToAllClasses();
    
  } catch (e) {
    console.error("Gagal load Firestore:", e);
    toast("Gagal sinkron database. Pakai data lokal.");
  } finally {
    setLoading(false); // <-- MATIKAN LOADING
  }
}

async function syncClassToFirestore(kelas) {
  const kelasFix = normalizeClassName(kelas);
  if (!kelasFix) return;
  resequenceClassAlphabetical(kelasFix);
  saveCacheDB();

  try {
    if (!patchFirestoreReady()) return;
    const db = firebase.firestore();
    const kelasRef = db.collection('kelas').doc(kelasFix).collection('siswa');
    const snapshot = await kelasRef.get();
    const students = (localDB[kelasFix] || []).map(s => normalizeStudentRow({ ...s, Kelas: kelasFix }));
    const desiredIds = new Set(students.map(s => patchSafeFirestoreDocId(normalizeAbsen(s.Absen))));
    
    let batch = db.batch();
    let count = 0;

    // Hapus hanya siswa yang sudah tidak ada di localDB
    for (const doc of snapshot.docs) {
      if (!desiredIds.has(doc.id)) {
        batch.delete(doc.ref);
        count++;
        if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
      }
    }

    // Set/Update siswa yang ada
    for (const s of students) {
      batch.set(kelasRef.doc(patchSafeFirestoreDocId(normalizeAbsen(s.Absen))), s, { merge: true });
      count++;
      if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
    }

    if (count > 0) await batch.commit();
  } catch (e) { console.error("Gagal sync kelas:", e); throw e; }
}

async function syncAllToFirestore() {
  setLoading(true, "Menyimpan semua kelas ke server...");
  try {
    for (const kelas of DAFTAR_KELAS) {
      await syncClassToFirestore(kelas);
    }
    
    const db = firebase.firestore();
    await db.collection("settings").doc("global").set(settings);
    
    toast("Semua data tersimpan di server ✅");
  } catch (e) {
    console.error("Gagal sync all:", e);
    toast("Gagal menyimpan ke server.");
  } finally {
    setLoading(false);
  }
}

async function saveSettingsToFirestore(){
  if (session.role !== "admin") return toast("Akses ditolak.");
  settings.lateCutoff = $("set-late")?.value || settings.lateCutoff;
  settings.alpaCutoff = $("set-alpa")?.value || settings.alpaCutoff;
  
  try {
    const db = firebase.firestore();
    await db.collection("settings").doc("global").set(settings);
    toast("Pengaturan tersimpan ✅");
  } catch (e) {
    console.error(e);
    toast("Gagal simpan settings.");
  }
}

// ===== SYNC DISPEN KE FIRESTORE =====
async function syncDispenToFirestore(tanggal) {
  try {
    const db = firebase.firestore();
    const daily = getDailyEventsForDate(tanggal);
    const batch = db.batch();
    const dispenRef = db.collection("dailyEvents").doc(tanggal).collection("dispen");
    
    // Hapus semua data lama
    const oldSnapshot = await dispenRef.get();
    oldSnapshot.forEach(doc => batch.delete(doc.ref));
    
    // Tambah data baru
    for (const [key, value] of Object.entries(daily.dispen || {})) {
      const docRef = dispenRef.doc(key);
      batch.set(docRef, value);
    }
    
    await batch.commit();
    console.log(`✅ Dispen ${tanggal} tersimpan ke Firestore`);
  } catch (e) {
    console.error("❌ Gagal sync dispen:", e);
  }
}

async function syncPulangCepatToFirestore(tanggal) {
  try {
    const db = firebase.firestore();
    const daily = getDailyEventsForDate(tanggal);
    const batch = db.batch();
    const pulangRef = db.collection("dailyEvents").doc(tanggal).collection("pulangCepat");
    
    // Hapus semua data lama
    const oldSnapshot = await pulangRef.get();
    oldSnapshot.forEach(doc => batch.delete(doc.ref));
    
    // Tambah data baru
    for (const [key, value] of Object.entries(daily.pulangCepat || {})) {
      const docRef = pulangRef.doc(key);
      batch.set(docRef, value);
    }
    
    await batch.commit();
    console.log(`✅ Pulang Cepat ${tanggal} tersimpan ke Firestore`);
  } catch (e) {
    console.error("❌ Gagal sync pulang cepat:", e);
  }
}

async function syncTerlambatToFirestore(tanggal) {
  try {
    const db = firebase.firestore();
    const daily = getDailyEventsForDate(tanggal);
    const batch = db.batch();
    const terlambatRef = db.collection("dailyEvents").doc(tanggal).collection("terlambat");
    
    // Hapus semua data lama
    const oldSnapshot = await terlambatRef.get();
    oldSnapshot.forEach(doc => batch.delete(doc.ref));
    
    // Tambah data baru
    for (const [key, value] of Object.entries(daily.terlambat || {})) {
      if (value && value !== "-") {
        const docRef = terlambatRef.doc(key);
        batch.set(docRef, { jam: value });
      }
    }
    
    await batch.commit();
    console.log(`✅ Terlambat ${tanggal} tersimpan ke Firestore`);
  } catch (e) {
    console.error("❌ Gagal sync terlambat:", e);
  }
}

// ===== LOAD DISPEN DARI FIRESTORE =====
async function loadDispenFromFirestore(tanggal) {
  try {
    const db = firebase.firestore();
    const snapshot = await db.collection("dailyEvents").doc(tanggal).collection("dispen").get();
    const daily = getDailyEventsForDate(tanggal);
    daily.dispen = {};
    snapshot.forEach(doc => {
      daily.dispen[doc.id] = doc.data();
    });
    saveDailyEventsForDate(tanggal, daily);
    console.log(`✅ Dispen ${tanggal} dimuat dari Firestore`);
  } catch (e) {
    console.error("❌ Gagal load dispen:", e);
  }
}

async function loadPulangCepatFromFirestore(tanggal) {
  try {
    const db = firebase.firestore();
    const snapshot = await db.collection("dailyEvents").doc(tanggal).collection("pulangCepat").get();
    const daily = getDailyEventsForDate(tanggal);
    daily.pulangCepat = {};
    snapshot.forEach(doc => {
      daily.pulangCepat[doc.id] = doc.data();
    });
    saveDailyEventsForDate(tanggal, daily);
    console.log(`✅ Pulang Cepat ${tanggal} dimuat dari Firestore`);
  } catch (e) {
    console.error("❌ Gagal load pulang cepat:", e);
  }
}

async function loadTerlambatFromFirestore(tanggal) {
  try {
    const db = firebase.firestore();
    const snapshot = await db.collection("dailyEvents").doc(tanggal).collection("terlambat").get();
    const daily = getDailyEventsForDate(tanggal);
    daily.terlambat = {};
    snapshot.forEach(doc => {
      daily.terlambat[doc.id] = doc.data().jam || "-";
    });
    saveDailyEventsForDate(tanggal, daily);
    console.log(`✅ Terlambat ${tanggal} dimuat dari Firestore`);
  } catch (e) {
    console.error("❌ Gagal load terlambat:", e);
  }
}

/* ===================== LOGIN ===================== */
function fillLoginClassSelect(){
  const sel = $("login-class");
  if (!sel) return;
  sel.innerHTML = "";
  DAFTAR_KELAS.forEach(k => {
    sel.innerHTML += `<option value="${k}">${k}</option>`;
  });
}

function onRoleChange(){
  toggleAccountFieldVisibility();
}

function openLogin(){
  show("modal-login");
  $("modal-login")?.classList.add("flex");
  if ($("login-username")) $("login-username").value = "";
  if ($("login-password")) $("login-password").value = "";
}

function closeLogin(){
  hide("modal-login");
  $("modal-login")?.classList.remove("flex");
}

function setBadge(){
  show("badge-role");
  let roleLabel = (session.role || "-").toUpperCase();
  if (session.role === "guru" && session.isWaliKelas && session.waliKelas) roleLabel = `GURU • WALI`;
  setText("badge-role-text", roleLabel);
  setText("badge-class-text", session.role === "orangtua" ? (session.kelas ? `KELAS ${session.kelas}` : "-") : (session.isWaliKelas && session.waliKelas ? `WALI ${session.waliKelas}` : "ALL CLASS"));
}

function getAvailableRoleTabs(){
  if (!session.role) return [];
  const tabs = [];
  if (session.role === "admin") {
    tabs.push({ id: "view-admin", label: "Admin" });
    tabs.push({ id: "view-piket", label: "Piket" });
    return tabs;
  }
  if (session.role === "guru") {
    tabs.push({ id: "view-profile", label: "Profile" });
    tabs.push({ id: "view-pelajaran", label: "Pelajaran" });
    if (session.isWaliKelas) tabs.push({ id: "view-wali", label: "Wali Kelas" });
    if (session.piketToday) tabs.push({ id: "view-piket", label: "Piket" });
    return tabs;
  }
  if (session.role === "orangtua") {
    tabs.push({ id: "view-ortu", label: "Orang Tua" });
    return tabs;
  }
  return tabs;
}

function renderRoleTabs(){
  const wrap = $("role-tabs-wrap");
  const list = $("role-tabs-list");
  if (!wrap || !list) return;
  const tabs = getAvailableRoleTabs();
  if (!tabs.length) {
    wrap.classList.add("hidden");
    list.innerHTML = "";
    activeRoleTab = null;
    return;
  }
  if (!activeRoleTab || !tabs.some(t => t.id === activeRoleTab)) {
    activeRoleTab = tabs[0].id;
  }
  list.innerHTML = tabs.map(tab => `<button class="role-tab-btn ${tab.id === activeRoleTab ? 'active' : ''}" data-tab-target="${tab.id}">${tab.label}</button>`).join("");
  wrap.classList.remove("hidden");
}

function applyRoleTabVisibility(){
  ["view-admin","view-wali","view-sekretaris","view-piket","view-ortu","view-pelajaran","view-profile"].forEach(hide);
  if (activeRoleTab) show(activeRoleTab);
}

function setRoleTab(tabId){
  stopAllScanners();
  activeRoleTab = tabId;
  renderRoleTabs();
  applyRoleTabVisibility();
}

function showRoleView(){
  renderRoleTabs();
  applyRoleTabVisibility();
}

async function doLogin(){
  const username = String($("login-username")?.value || "").trim();
  const password = String($("login-password")?.value || "").trim();

  if (!username || !password) return toast("Username dan password wajib diisi.");

  const user = findAccountByUsername(username);
  if (!user || user.password !== password) return toast("Username atau password salah.");
  if (!["admin", "guru", "orangtua"].includes(user.role)) {
    return toast("Role akun ini sudah tidak didukung. Edit role dari admin terlebih dulu.");
  }

  session.username = user.username;
  session.displayName = user.displayName || user.username;
  session.role = user.role;
  session.kelas = user.role === "orangtua" ? (user.kelas || null) : (user.isWaliKelas ? (user.waliKelas || null) : null);
  session.parentAbsen = user.parentAbsen || null;
  session.parentPhone = user.parentPhone || null;
  session.piketToday = isScheduledPicketToday(user.username);
  session.isWaliKelas = !!user.isWaliKelas;
  session.waliKelas = user.waliKelas || null;
  session.nip = user.nip || "";
  session.mengajar = Array.isArray(user.mengajar) ? user.mengajar : [];

  saveSession();
  activeRoleTab = null;
  setBadge();
  show("btn-logout");
  closeLogin();
  showRoleView();
  renderAll();

  if (session.role === "orangtua") {
    const student = getParentStudent();
    if (!student) toast("Akun orang tua belum terkait ke siswa yang valid.");
  }
}

async function doLogout(){
  await stopAllScanners();
  stopParentWatcher();

  session = {
    username: null,
    displayName: null,
    role: null,
    kelas: null,
    mode: "HADIR",
    parentAbsen: null,
    parentPhone: null,
    piketToday: false,
    isWaliKelas: false,
    waliKelas: null,
    nip: null,
    mengajar: []
  };

  localStorage.removeItem("ABSEN_SESSION");
  hide("btn-logout");
  hide("badge-role");
  hide("view-admin");
  hide("view-wali");
  hide("view-sekretaris");
  hide("view-piket");
  hide("view-ortu");
  hide("view-pelajaran");
  hide("role-tabs-wrap");
  activeRoleTab = null;
  openLogin();
}

/* ===================== DATA ===================== */
async function addStudent({ nama, kelas, absen, jk, agama, phone, nik = '', nisn = '-', nis = '-' }){
  ensureBuckets();

  const kelasFix = normalizeClassName(kelas);
  const absenFix = normalizeAbsen(absen || nextAbsenForClass(kelasFix));
  const phoneFix = normalizePhone(phone);
  const nikFix = normalizeNik(nik);

  if (!nama || !absenFix) throw new Error("Nama/Absen wajib.");
  if (nikFix && findStudentByNik(nikFix)) throw new Error("NIK sudah terdaftar.");

  if (localDB[kelasFix].some(s => normalizeAbsen(s.Absen) === absenFix)) {
    throw new Error("Absen sudah terdaftar.");
  }

  localDB[kelasFix].push(normalizeStudentRow({
    NIK: nikFix,
    NISN: nisn,
    NIS: nis,
    Nama: nama.trim(),
    Kelas: kelasFix,
    Absen: absenFix,
    JK: jk,
    Jenis: jk,
    Agama: agama,
    NoHP: phoneFix || "-"
  }));

  saveCacheDB();
  await syncClassToFirestore(kelasFix);
}

function timeToMinutes(t){
  if (!t || t === "-") return null;
  const tFix = String(t).replace(/\./g, ':');
  const [h, m] = tFix.split(":").map(x => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function currentMinutes(){
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function lockedClassRequired(){
  return session.role === "guru" && session.isWaliKelas;
}

async function markAttendance({ kelas, absen, status, jamOverride = null, note = null }){
  ensureBuckets();
  const today = todayId();
  const idx = (localDB[kelas] || []).findIndex(s => normalizeAbsen(s.Absen) === normalizeAbsen(absen));
  if (idx === -1) return { ok: false, msg: `Data tidak ada di kelas ${kelas}.` };

  if (lockedClassRequired() && kelas !== session.kelas) {
    return { ok: false, msg: `Kelas tidak sesuai. Wajib ${session.kelas}.` };
  }

  const s = localDB[kelas][idx];
  const already = s.Tanggal === today;
  const jam = jamOverride || nowTimeId();

  const oldStatus = s.Status;

  s.Tanggal = today;
  s.Status = status;
  s.Jam = status === "ALPA" ? "-" : jam;
  s.Catatan = note?.trim() || s.Catatan || "-";

  if (!already) {
    if (status === "HADIR") s.Hadir++;
    else if (status === "IZIN") s.Izin++;
    else if (status === "SAKIT") s.Sakit++;
    else if (status === "ALPA") s.Alpa++;
  } else {
    if (oldStatus !== status) {
      if (oldStatus === "HADIR") s.Hadir = Math.max(0, s.Hadir - 1);
      else if (oldStatus === "IZIN") s.Izin = Math.max(0, s.Izin - 1);
      else if (oldStatus === "SAKIT") s.Sakit = Math.max(0, s.Sakit - 1);
      else if (oldStatus === "ALPA") s.Alpa = Math.max(0, s.Alpa - 1);
      
      if (status === "HADIR") s.Hadir++;
      else if (status === "IZIN") s.Izin++;
      else if (status === "SAKIT") s.Sakit++;
      else if (status === "ALPA") s.Alpa++;
    }
  }

  const daily = getDailyEvents();
  const skey = studentKey(kelas, absen);

  if (typeof s.Terlambat !== 'number' || isNaN(s.Terlambat)) {
    s.Terlambat = 0;
  }

  daily.terlambat[skey] = "-";

  const jamFix = jam.replace(/\./g, ':');
  const [jH, jM] = jamFix.split(":").map(Number);
  const jamAngka = jH * 60 + jM;

  const lateCutoff = settings.lateCutoff || "06:30";
  const [bH, bM] = lateCutoff.split(":").map(Number);
  const batasTelat = bH * 60 + bM;

  const MIN_PRESENSI = 5 * 60 + 0;

  if (status === "HADIR") {
  if (jamAngka < MIN_PRESENSI) {
    return { 
      ok: false, 
      msg: `Presensi belum dimulai! Minimal jam 05:00. (Sekarang ${jam})` 
    };
  }
  
  if (jamAngka > batasTelat) {
    daily.terlambat[skey] = jam;
    if (!already) {
      s.Terlambat = (s.Terlambat || 0) + 1;
    }
    
    // ===== TAMBAH INI =====
    s.JamTerlambat = jam;
    syncTerlambatToFirestore(today).catch(console.error);
    // =====
  }
}

  saveDailyEvents(daily);
  saveCacheDB();
  await syncClassToFirestore(kelas);

  return { ok: true, student: s, edited: already };
}

/* ===================== DISPEN / PULANG ===================== */
function upsertDispen({ kelas, absen, waktu, outTime, backTime, alasan }){
  const daily = getDailyEvents();
  const skey = studentKey(kelas, absen);
  const today = todayId();
  const prev = daily.dispen[skey] || {};

  daily.dispen[skey] = {
    out: waktu || outTime || prev.out || "-",
    back: backTime || prev.back || "-",
    alasan: alasan || prev.alasan || "-"
  };

  saveDailyEvents(daily);
  
  // SYNC KE FIRESTORE
  syncDispenToFirestore(today).catch(console.error);

  const idx = (localDB[kelas] || []).findIndex(s => normalizeAbsen(s.Absen) === normalizeAbsen(absen));
  if (idx !== -1) {
    const s = localDB[kelas][idx];
    if (!daily.dispen[skey]._counted) {
      s.Dispen = Number(s.Dispen || 0) + 1;
      daily.dispen[skey]._counted = true;
      saveDailyEvents(daily);
    }
    s.Catatan = alasan || s.Catatan || "-";
    saveCacheDB();
    syncClassToFirestore(kelas).catch(console.error);
  }
  
  // PAKSA NOTIF
  setTimeout(() => checkParentStatusChange(), 1000);
}

function markBackDispen({ kelas, absen, backTime }){  // <-- PAKE backTime
  const daily = getDailyEvents();
  const skey = studentKey(kelas, absen);
  const today = todayId();
  
  if (!daily.dispen[skey]) return false;
  daily.dispen[skey].back = backTime || nowTimeId();
  saveDailyEvents(daily);
  
  // SYNC KE FIRESTORE
  syncDispenToFirestore(today).catch(console.error);
  
  // PAKSA NOTIF
  setTimeout(() => checkParentStatusChange(), 1000);
  
  return true;
}

function setPulangCepat({ kelas, absen, waktu, time, alasan }){
  const daily = getDailyEvents();
  const skey = studentKey(kelas, absen);
  const today = todayId();

  daily.pulangCepat[skey] = {
    time: waktu || time || "-",
    alasan: alasan || "-"
  };

  saveDailyEvents(daily);
  
  // SYNC KE FIRESTORE
  syncPulangCepatToFirestore(today).catch(console.error);

  const idx = (localDB[kelas] || []).findIndex(s => normalizeAbsen(s.Absen) === normalizeAbsen(absen));
  if (idx !== -1) {
    const s = localDB[kelas][idx];
    if (!daily.pulangCepat[skey]._counted) {
      s.PulangCepat = Number(s.PulangCepat || 0) + 1;
      daily.pulangCepat[skey]._counted = true;
      saveDailyEvents(daily);
    }
    s.Catatan = alasan || s.Catatan || "-";
    saveCacheDB();
    syncClassToFirestore(kelas).catch(console.error);
  }
  
  // PAKSA NOTIF
  setTimeout(() => checkParentStatusChange(), 1000);
}

/* ===================== QR ===================== */
function renderSingleQR(targetEl, { nama, kelas, absen, jk, agama, nik }){
  if (!targetEl) return;
  const payload = makeQrPayload({ nama, kelas, absen, jk, agama, nik });

  targetEl.innerHTML = `
    <div class="p-8 bg-white rounded-[2.5rem] flex flex-col items-center mt-2 w-full max-w-[360px]" id="card-single">
      <div id="qr-single" class="mb-4"></div>
      <b class="text-black uppercase text-xl text-center">${safeUpper(nama)}</b>
      <p class="text-gray-600 font-bold uppercase text-[9px] text-center mt-1">${kelas} • ${jk} • ${agama} • ${nik ? `NIK ${nik}` : `ABSEN ${absen}`}</p>
    </div>
    <button class="mt-4 bg-cyan-600 hover:bg-cyan-500 p-4 w-full max-w-[360px] rounded-2xl font-black italic text-white text-xs uppercase" id="btn-dl-single">
      Simpan Kartu QR
    </button>
  `;

  const qrBox = document.getElementById("qr-single");
  qrBox.innerHTML = "";
  new QRCode(qrBox, {
    text: payload,
    width: 210,
    height: 210,
    correctLevel: QRCode.CorrectLevel.H
  });

  document.getElementById("btn-dl-single").onclick = async () => {
    const card = document.getElementById("card-single");
    const canvas = await html2canvas(card, { scale: 3 });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `QR_${kelas}_${normalizeNik(nik) || `ABSEN${absen}`}_${nama}.png`;
    a.click();
  };
}

async function waitForNextPaint(times = 2){
  for (let i = 0; i < times; i++) {
    await new Promise(r => requestAnimationFrame(() => r()));
  }
}

async function waitForQrRendered(container){
  await waitForNextPaint(2);
  const started = Date.now();
  while (Date.now() - started < 2500) {
    const img = container.querySelector("img");
    const cvs = container.querySelector("canvas");
    if (img && img.complete) return;
    if (cvs) return;
    await new Promise(r => setTimeout(r, 40));
  }
}

async function bulkProcessAndZipForClass(kelas, textareaValue){
  const input = (textareaValue || "").trim();
  if (!input) return toast("Bulk kosong.");
  ensureBuckets();

  const lines = input.split("\n").map(x => x.trim()).filter(Boolean);
  if (!lines.length) return toast("Bulk kosong.");

  setLoading(true, "Membuat kartu QR massal...");
  const zip = new JSZip();
  const engine = $("hidden-qr-engine");

  try {
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i];
      const parts = row.split(/\s+/);
      if (parts.length < 5) continue;

      const phone = parts.pop();
      const agama = parts.pop();
      const jk = parts.pop();
      const absen = normalizeAbsen(parts.pop());
      const nama = parts.join(" ");

      if (!nama || !absen || isNaN(Number(absen))) continue;

      if (!localDB[kelas].some(s => normalizeAbsen(s.Absen) === absen)) {
        localDB[kelas].push(normalizeStudentRow({
          Nama: nama,
          Kelas: kelas,
          Absen: absen,
          JK: jk,
          Agama: agama,
          NoHP: normalizePhone(phone)
        }));
      }

      const tmpId = `tmp-card-${Date.now()}-${i}`;
      engine.innerHTML = `
        <div id="${tmpId}" style="padding:40px;background:white;width:360px;text-align:center;border-radius:28px;">
          <div id="${tmpId}-qr" style="display:flex;justify-content:center;"></div>
          <div style="margin-top:18px;">
            <b style="color:black;font-size:22px;text-transform:uppercase;display:block;">${safeUpper(nama)}</b>
            <p style="color:#666;font-weight:700;font-size:12px;text-transform:uppercase;margin-top:6px;">
              ${kelas} • ${jk} • ${agama} • ${nik ? `NIK ${nik}` : `ABSEN ${absen}`}
            </p>
          </div>
        </div>
      `;

      const payload = makeQrPayload({ nama, kelas, absen, jk, agama });
      const qrBox = document.getElementById(`${tmpId}-qr`);
      qrBox.innerHTML = "";
      new QRCode(qrBox, { text: payload, width: 250, height: 250, correctLevel: QRCode.CorrectLevel.M });

      await waitForQrRendered(qrBox);
      await waitForNextPaint(1);

      const cardEl = document.getElementById(tmpId);
      const canvas = await html2canvas(cardEl, { scale: 1.5 });
      const b64 = canvas.toDataURL("image/png").split(",")[1];
      const safeName = nama.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60);
      zip.file(`${kelas}/QR_${absen}_${safeName}.png`, b64, { base64: true });

      setText("loading-text", `Membuat kartu... (${i + 1}/${lines.length})`);
    }

    await syncClassToFirestore(kelas);
    saveCacheDB();

    const content = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(content);
    a.download = `QR_BULK_${kelas}_${todayId().replace(/\//g, "-")}.zip`;
    a.click();

    toast("Selesai ✅ ZIP terunduh.");
  } catch (e) {
    console.error(e);
    toast("Bulk gagal. Cek console.");
  } finally {
    setLoading(false);
  }
}


async function buildQrZipForStudents(students, zipBaseName = 'QR_SISWA_BULK'){
  if (!students.length) return null;
  const zip = new JSZip();
  const engine = $("hidden-qr-engine");
  setLoading(true, 'Membuat QR massal...');
  try {
    for (let i = 0; i < students.length; i++) {
      const s = normalizeStudentRow(students[i]);
      const tmpId = `bulk-student-${Date.now()}-${i}`;
      engine.innerHTML = `
        <div id="${tmpId}" style="padding:40px;background:white;width:360px;text-align:center;border-radius:28px;">
          <div id="${tmpId}-qr" style="display:flex;justify-content:center;"></div>
          <div style="margin-top:18px;">
            <b style="color:black;font-size:22px;text-transform:uppercase;display:block;">${safeUpper(s.Nama)}</b>
            <p style="color:#666;font-weight:700;font-size:12px;text-transform:uppercase;margin-top:6px;">${s.Kelas} • ${s.JK} • ${s.Agama} • NIK ${s.NIK || '-'}</p>
          </div>
        </div>
      `;
      const qrBox = document.getElementById(`${tmpId}-qr`);
      qrBox.innerHTML = '';
      new QRCode(qrBox, { text: makeQrPayload({ nik: s.NIK, nama: s.Nama, kelas: s.Kelas, absen: s.Absen, jk: s.JK, agama: s.Agama }), width: 250, height: 250, correctLevel: QRCode.CorrectLevel.M });
      await waitForQrRendered(qrBox);
      await waitForNextPaint(1);
      const cardEl = document.getElementById(tmpId);
      const canvas = await html2canvas(cardEl, { scale: 1.5 });
      const b64 = canvas.toDataURL('image/png').split(',')[1];
      const safeName = String(s.Nama || 'SISWA').replace(/[\/:*?"<>|]/g, '-').slice(0, 60);
      const safeNik = normalizeNik(s.NIK) || 'NO-NIK';
      zip.file(`${s.Kelas}/QR_${safeName}_${safeNik}.png`, b64, { base64: true });
      setText('loading-text', `Membuat QR... (${i + 1}/${students.length})`);
    }
    return await zip.generateAsync({ type: 'blob' });
  } finally {
    setLoading(false);
  }
}

function parseBulkStudentText(text){
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return lines.map((line, idx) => {
    const parts = line.split('-').map(x => x.trim());
    if (parts.length < 7) throw new Error(`Baris ${idx + 1} tidak valid. Format wajib: nik-nisn-nis-nama-kelas-jenis-agama`);
    const [nik, nisn, nis, nama, kelas, jenis, agama] = parts;
    return { nik, nisn, nis, nama, kelas, jenis, agama };
  });
}

function rowsFromSheetData(rows){
  return rows.map((row, idx) => {
    const get = (keys) => {
      for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') return String(row[key]).trim();
      }
      return '';
    };
    return {
      nik: get(['nik','NIK']),
      nisn: get(['nisn','NISN']),
      nis: get(['nis','NIS']),
      nama: get(['nama','Nama','NAMA']),
      kelas: get(['kelas','Kelas','KELAS']),
      jenis: get(['jenis','Jenis','JK','jk']),
      agama: get(['agama','Agama','AGAMA'])
    };
  }).filter(r => r.nik || r.nama || r.kelas);
}

async function importStudentsBulk(rows, options = {}){
  ensureBuckets();
  const touched = new Set();
  const imported = [];
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const nik = normalizeNik(row.nik);
    const nama = String(row.nama || '').trim();
    const kelas = normalizeClassName(row.kelas);
    const jenis = String(row.jenis || '-').trim() || '-';
    const agama = String(row.agama || '-').trim() || '-';
    const nisn = String(row.nisn || '-').trim() || '-';
    const nis = String(row.nis || '-').trim() || '-';
    if (!nik || !nama || !kelas) {
      errors.push(`Baris ${i + 1}: NIK/Nama/Kelas wajib diisi.`);
      continue;
    }
    if (!DAFTAR_KELAS.includes(kelas)) {
      errors.push(`Baris ${i + 1}: Kelas ${kelas} tidak dikenal.`);
      continue;
    }
    if (findStudentByNik(nik)) {
      errors.push(`Baris ${i + 1}: NIK ${nik} sudah ada.`);
      continue;
    }
    const absen = nextAbsenForClass(kelas);
    const student = normalizeStudentRow({ NIK: nik, NISN: nisn, NIS: nis, Nama: nama, Kelas: kelas, Absen: absen, Jenis: jenis, JK: jenis, Agama: agama, NoHP: '-' });
    localDB[kelas].push(student);
    imported.push(student);
    touched.add(kelas);
  }
  if (imported.length) {
    saveCacheDB();
    for (const kelas of touched) await syncClassToFirestore(kelas);
  }
  let zipBlob = null;
  if (imported.length && options.generateZip !== false) {
    zipBlob = await buildQrZipForStudents(imported, options.zipBaseName || `QR_SISWA_BULK_${todayId().replace(/\//g,'-')}`);
  }
  return { imported, errors, zipBlob };
}

function downloadTemplateBulkSiswa(){
  const rows = [
    { nik: '318918', nisn: '324837', nis: '62326', nama: 'gema', kelas: 'XI-1', jenis: 'L', agama: 'Islam' },
    { nik: '66276', nisn: '234263', nis: '23423', nama: 'asep', kelas: 'XI-1', jenis: 'L', agama: 'Islam' }
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'template_siswa');
  XLSX.writeFile(wb, 'TEMPLATE_BULK_SISWA.xlsx');
}

async function handleAdminBulkStudentImportText(){
  const text = $("admin-student-bulk")?.value || '';
  if (!text.trim()) return toast('Bulk siswa kosong.');
  try {
    const rows = parseBulkStudentText(text);
    const result = await importStudentsBulk(rows, { generateZip: true, zipBaseName: `QR_SISWA_IMPORT_${todayId().replace(/\//g,'-')}` });
    const msgs = [`Import berhasil: ${result.imported.length} siswa`];
    if (result.errors.length) msgs.push(`Error: ${result.errors.length}`);
    setText('admin-student-import-log', msgs.join(' • '));
    if (result.zipBlob) downloadBlobFile(result.zipBlob, `QR_SISWA_IMPORT_${todayId().replace(/\//g,'-')}.zip`);
    if (result.errors.length) console.warn(result.errors);
    renderAll();
    toast(`Import selesai. ${result.imported.length} siswa masuk.`);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Import bulk gagal.');
  }
}

async function handleAdminBulkStudentImportFile(){
  const file = $("admin-student-file")?.files?.[0];
  if (!file) return toast('Pilih file dulu.');
  try {
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const rows = rowsFromSheetData(json);
    if (!rows.length) return toast('Isi file kosong atau kolom tidak cocok.');
    const result = await importStudentsBulk(rows, { generateZip: true, zipBaseName: `QR_SISWA_FILE_${todayId().replace(/\//g,'-')}` });
    setText('admin-student-import-log', `Import file berhasil: ${result.imported.length} siswa • Error: ${result.errors.length}`);
    if (result.zipBlob) downloadBlobFile(result.zipBlob, `QR_SISWA_FILE_${todayId().replace(/\//g,'-')}.zip`);
    if (result.errors.length) console.warn(result.errors);
    renderAll();
    toast(`Import file selesai. ${result.imported.length} siswa masuk.`);
  } catch (e) {
    console.error(e);
    toast('Gagal baca file bulk siswa.');
  }
}

async function downloadAllStudentQrZip(){
  const students = [];
  DAFTAR_KELAS.forEach(k => students.push(...(localDB[k] || [])));
  if (!students.length) return toast('Belum ada data siswa.');
  const blob = await buildQrZipForStudents(students, `QR_SEMUA_SISWA_${todayId().replace(/\//g,'-')}`);
  if (blob) downloadBlobFile(blob, `QR_SEMUA_SISWA_${todayId().replace(/\//g,'-')}.zip`);
}

/* ===================== LIST / LOG ===================== */
function collectLogs(scope){
  const today = todayId();
  const out = [];

  if (scope === "class" && session.kelas) {
    (localDB[session.kelas] || []).forEach(s => {
      if (s.Tanggal === today) out.push({ ...s });
    });
  } else {
    DAFTAR_KELAS.forEach(k => {
      (localDB[k] || []).forEach(s => {
        if (s.Tanggal === today) out.push({ ...s });
      });
    });
  }

  out.sort((a, b) => (b.Jam || "").localeCompare(a.Jam || ""));
  return out;
}

function renderLogTo(el, logs){
  if (!el) return;
  if (!logs.length) {
    el.innerHTML = `<p class="text-center text-gray-600 py-10 italic text-[10px] uppercase">Belum ada aktivitas presensi hari ini.</p>`;
    return;
  }

  const daily = getDailyEvents();

  el.innerHTML = logs.slice(0, 120).map(d => {
    const skey = studentKey(d.Kelas, d.Absen);
    const late = daily.terlambat[skey] && daily.terlambat[skey] !== "-" ? `Terlambat ${daily.terlambat[skey]}` : "";
    const dis = daily.dispen[skey] ? `Dispen ${daily.dispen[skey].out || "-"}-${daily.dispen[skey].back || "-"}` : "";
    const pul = daily.pulangCepat[skey] ? `Pulang ${daily.pulangCepat[skey].time || "-"}` : "";
    const extra = [late, dis, pul].filter(Boolean).join(" • ");

    return `
      <div class="log-item glass p-4 rounded-2xl flex justify-between items-center border-l-4 border-cyan-500 mb-2">
        <div>
          <b class="text-white text-xs uppercase">${safeUpper(d.Nama)}</b>
          <div class="text-[9px] text-gray-500 uppercase font-bold">
            ${d.Kelas} • ABSEN ${d.Absen} • ${d.Status} • ${d.Jam}
            ${extra ? `<span class="text-cyan-300"> • ${extra}</span>` : ``}
          </div>
        </div>
        <div class="bg-gray-900 px-3 py-1 rounded-lg text-cyan-300 font-black text-[10px] uppercase">
          ${d.Agama || "-"}
        </div>
      </div>
    `;
  }).join("");
}

function buildStudentList(scope, query){
  query = (query || "").trim().toLowerCase();
  const list = [];

  const addFromClass = (k) => {
    (localDB[k] || []).forEach(s => list.push({ ...s }));
  };

  if (scope === "class" && session.kelas) addFromClass(session.kelas);
  else DAFTAR_KELAS.forEach(addFromClass);

  const filtered = !query ? list : list.filter(s => {
    const hay = `${s.Nama} ${s.Absen} ${s.Kelas}`.toLowerCase();
    return hay.includes(query);
  });

  filtered.sort((a, b) => Number(a.Absen) - Number(b.Absen));
  return filtered;
}

function renderManualList(el, students){
  if (!el) return;
  if (!students.length) {
    el.innerHTML = `<p class="text-center text-gray-600 py-10 italic text-[10px] uppercase">Data kosong / tidak ditemukan.</p>`;
    return;
  }

  el.innerHTML = students.map(s => `
    <button class="w-full text-left glass p-4 rounded-2xl hover:border-cyan-500/40 transition-all"
      data-kelas="${s.Kelas}" data-absen="${s.Absen}">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-xs font-black text-white uppercase">${safeUpper(s.Nama)}</div>
          <div class="text-[9px] text-gray-500 uppercase font-bold">
            ${s.Kelas} • ABSEN ${s.Absen} • ${s.JK || "-"} • ${s.Agama || "-"}
          </div>
        </div>
        <div class="text-[10px] font-black uppercase tracking-widest text-gray-300">
          ${s.Tanggal === todayId() ? "✅ DONE" : "—"}
        </div>
      </div>
    </button>
  `).join("");

  el.querySelectorAll("button[data-kelas]").forEach(btn => {
    btn.onclick = () => {
      openActionModal({
        kelas: btn.getAttribute("data-kelas"),
        absen: btn.getAttribute("data-absen")
      });
    };
  });
}

function renderOrtuDashboard(){
  const student = getParentStudent();
  if (!student) return;

  const notifEnabled = localStorage.getItem("PARENT_NOTIF_ENABLED") === "1";
  const warningEl = $("ortu-notif-warning");
  
  if (warningEl) {
    if (!notifEnabled) {
      warningEl.innerHTML = `
        <div class="bg-red-900/50 border border-red-500 p-6 rounded-2xl text-center mb-4">
          <p class="text-red-400 font-black text-xs uppercase tracking-widest">⚠️ PERINGATAN ⚠️</p>
          <p class="text-white text-sm mt-2">Notifikasi belum aktif! Untuk menerima update anak, aktifkan notifikasi.</p>
          <button onclick="enableParentNotification()" class="mt-4 bg-red-600 hover:bg-red-500 px-6 py-3 rounded-xl text-white font-black text-xs uppercase tracking-widest">
            AKTIFKAN SEKARANG
          </button>
        </div>
      `;
    } else {
      warningEl.innerHTML = '';
    }
  }

  setText("ortu-nama", student.Nama || "-");
  setText("ortu-kelas", `${student.Kelas} • ABSEN ${student.Absen}`);
  setText("ortu-status", `${student.Status || "-"} • ${student.Jam || "-"}`);

  setText("ortu-hadir", student.Hadir || 0);
  setText("ortu-terlambat", student.Terlambat || 0);
  setText("ortu-izin", student.Izin || 0);
  setText("ortu-sakit", student.Sakit || 0);
  setText("ortu-alpa", student.Alpa || 0);
  setText("ortu-dispen", student.Dispen || 0);
  setText("ortu-pulangcepat", student.PulangCepat || 0);
  setText("ortu-notif-info", notifEnabled ? "Notifikasi aktif di HP ini ✅" : "Notifikasi belum aktif");

  const el = $("ortu-log");
  if (!el) return;

  const daily = getDailyEvents();
  const skey = studentKey(student.Kelas, student.Absen);

  const items = [
    `Status hari ini: ${student.Status || "-"}`,
    `Jam: ${student.Jam || "-"}`,
    `Terlambat: ${daily.terlambat[skey] || "-"}`,
    `Dispen: ${daily.dispen[skey] ? `${daily.dispen[skey].out || "-"} - ${daily.dispen[skey].back || "-"}` : "-"}`,
    `Pulang Cepat: ${daily.pulangCepat[skey] ? daily.pulangCepat[skey].time || "-" : "-"}`,
    `Catatan: ${student.Catatan || "-"}`
  ];

  el.innerHTML = items.map(txt => `
    <div class="glass p-4 rounded-2xl border-l-4 border-cyan-500">
      <div class="text-xs font-bold text-white">${txt}</div>
    </div>
  `).join("");
}

/* ===================== MODAL ACTION ===================== */
function resetActionModalInputs(){
  if ($("ma-time")) $("ma-time").value = "";
  if ($("ma-note")) $("ma-note").value = "";
  if ($("ma-dispen-out")) $("ma-dispen-out").value = "";
  if ($("ma-dispen-back")) $("ma-dispen-back").value = "";
  if ($("ma-early")) $("ma-early").value = "";
}

function openActionModal({ kelas, absen }){
  if (lockedClassRequired() && kelas !== session.kelas) {
    return toast(`Kelas tidak sesuai. Kamu hanya ${session.kelas}.`);
  }

  modalTarget = { kelas, absen, chosenStatus: session.mode || "HADIR" };
  const s = (localDB[kelas] || []).find(x => normalizeAbsen(x.Absen) === normalizeAbsen(absen));
  setText("ma-title", "AKSI SISWA");
  setText("ma-sub", `${safeUpper(s?.Nama || "-")} • ${kelas} • ABSEN ${normalizeAbsen(absen)}`);
  resetActionModalInputs();
  
  // ===== SEMBUNYIKAN DISPEN & PULANG CEPAT UNTUK SEMUA ROLE =====
  const dispenSection = document.getElementById("ma-dispen-section");
  const earlySection = document.getElementById("ma-early-section");
  
  if (dispenSection) dispenSection.style.display = "none";
  if (earlySection) earlySection.style.display = "none";
  // ===== SELESAI =====

  const hapusBtn = document.getElementById("ma-hapus");
  if (hapusBtn) {
    if (session.role === "admin" || (session.role === "guru" && session.isWaliKelas)) {
      hapusBtn.classList.remove("hidden");
      hapusBtn.onclick = async () => {
        closeActionModal();
        await hapusSiswa(kelas, absen);
      };
    } else {
      hapusBtn.classList.add("hidden");
    }
  }
  
  show("modal-action");
  $("modal-action")?.classList.add("flex");
}

function closeActionModal(){
  hide("modal-action");
  $("modal-action")?.classList.remove("flex");
}

function setChosenStatus(status){
  modalTarget.chosenStatus = status;
}

/* ===================== FEEDBACK ===================== */
function showFeedback(prefix, icon, name, info, bg){
  const fb = $(`scan-feedback-${prefix}`);
  const icons = $(`check-icons-${prefix}`);
  const nm = $(`scanned-name-${prefix}`);
  const inf = $(`scanned-info-${prefix}`);
  const wrap = $(`feedback-content-${prefix}`);

  if (!fb || !icons || !nm || !inf || !wrap) return;

  icons.innerText = icon;
  nm.innerText = name;
  inf.innerText = info;
  wrap.className = `text-center text-white p-10 rounded-[2rem] shadow-2xl ${bg} border border-white/20`;
  fb.classList.remove("hidden");
  setTimeout(() => fb.classList.add("hidden"), 1600);
}

/* ===================== SCANNER ===================== */
async function startScanner(prefix){
  const startBtn = $(`${prefix}-start-cam`);
  const stopBtn = $(`${prefix}-stop-cam`);
  startBtn?.classList.add("hidden");
  stopBtn?.classList.remove("hidden");

  if (!scanners[prefix]) {
    scanners[prefix] = new Html5Qrcode(`reader-${prefix}`);
  }

  try {
    await scanners[prefix].start(
      { facingMode: "environment" },
      { fps: 20, qrbox: 250 },
      async (text) => onScan(prefix, text)
    );
  } catch (e) {
    console.error(e);
    toast("Gagal buka kamera. Pastikan HTTPS & izin kamera.");
    startBtn?.classList.remove("hidden");
    stopBtn?.classList.add("hidden");
  }
}

async function stopScanner(prefix){
  try {
    if (scanners[prefix] && scanners[prefix].isScanning) {
      await scanners[prefix].stop();
    }
  } catch {}
  $(`${prefix}-start-cam`)?.classList.remove("hidden");
  $(`${prefix}-stop-cam`)?.classList.add("hidden");
}

async function stopAllScanners(){
  await Promise.all(["admin", "wali", "sekretaris", "piket", "pelajaran"].map(p => stopScanner(p)));
}

async function onScan(prefix, text){
  const now = Date.now();
  if (text === scanMemory[prefix].text && (now - scanMemory[prefix].at) < SCAN_COOLDOWN_MS) return;
  scanMemory[prefix] = { text, at: now };

  const payload = parsePayload(text);
  if (!payload) return showFeedback(prefix, "❌", "QR INVALID", "FORMAT TIDAK SESUAI", "bg-red-700");

  const { nama, kelas, absen } = payload;

  if (prefix === "pelajaran") {
    const active = currentLessonSession();
    if (!active) return showFeedback(prefix, "❌", safeUpper(nama), "MULAI ABSENSI KELAS DULU", "bg-red-700");
    if (active.kelas !== kelas) return showFeedback(prefix, "❌", safeUpper(nama), `KELAS AKTIF ${active.kelas}, QR ${kelas}`, "bg-red-700");
    const r = await markLessonAttendance({ kelas, absen, status: "HADIR", source: "SCAN QR" });
    if (!r.ok) return showFeedback(prefix, "❌", safeUpper(nama), r.msg, "bg-red-700");
    showFeedback(prefix, "✅", safeUpper(r.student.Nama), `PELAJARAN HADIR • ${kelas} • ABSEN ${absen}`, "bg-green-700");
    renderAll();
    return;
  }

  if (lockedClassRequired() && kelas !== session.kelas) {
    return showFeedback(prefix, "❌", safeUpper(nama), `KELAS TIDAK SESUAI (WAJIB ${session.kelas})`, "bg-red-700");
  }

  const status = session.mode || "HADIR";
  const r = await markAttendance({ kelas, absen, status });

  if (!r.ok) return showFeedback(prefix, "❌", safeUpper(nama), r.msg, "bg-red-700");

  const icon = status === "HADIR" ? "✅" : status === "IZIN" ? "📝" : status === "SAKIT" ? "🤒" : "❌";
  const tag = r.edited ? " (EDIT)" : "";
  showFeedback(prefix, icon, safeUpper(r.student.Nama), `PRESENSI ${status}${tag} • ${kelas} • ABSEN ${absen}`, "bg-green-700");
  renderAll();
}

/* ===================== EXPORT ===================== */
function dateRangeDays(n){
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(x.toLocaleDateString("id-ID"));
  }
  return out;
}

/* ===================== EXPORT ===================== */
function rowsForDate(dateId, scope, kelasLocked = null){
  const daily = getDailyEvents();
  const rows = [];

  console.log("🔍 rowsForDate - Mencari tanggal:", dateId);
  console.log("📦 localDB:", localDB);

  const pushFromClass = (k) => {
    console.log(`📁 Kelas ${k}: ${localDB[k]?.length || 0} siswa`);
    
    (localDB[k] || []).slice().sort((a, b) => Number(a.Absen) - Number(b.Absen)).forEach(s => {
      // PAKSA JADI STRING DAN TRIM
      const tanggalSiswa = String(s.Tanggal || "").trim();
      const tanggalTarget = String(dateId || "").trim();
      
      console.log(`👤 ${s.Nama}: Tanggal siswa="${tanggalSiswa}", target="${tanggalTarget}", match=${tanggalSiswa === tanggalTarget}`);
      
      if (tanggalSiswa === tanggalTarget) {
        const skey = studentKey(s.Kelas, s.Absen);
        const row = {
          "Nama": safeUpper(s.Nama),
          "Kelas": s.Kelas,
          "Absen": String(s.Absen),
          "JK": s.JK || "-",
          "Agama": s.Agama || "-",
          "Jam": s.Jam || "-",
          "Jam Terlambat": s.JamTerlambat || "-",
          "Tanggal": dateId,
          "Status": s.Status || "-",
          "Dispen": daily.dispen[skey] ? `${daily.dispen[skey].out || "-"}` : "-",
          "Dispen Balik": daily.dispen[skey] && daily.dispen[skey].back ? daily.dispen[skey].back : "-",
          "Pulang Cepat": daily.pulangCepat[skey] ? daily.pulangCepat[skey].time || "-" : "-",
          "Catatan": s.Catatan || "-"
        };
        rows.push(row);
        console.log("✅ DATA DITEMUKAN:", row);
      }
    });
  };

  if (scope === "class" && kelasLocked) {
    pushFromClass(kelasLocked);
  } else {
    DAFTAR_KELAS.forEach(pushFromClass);
  }

  console.log("📊 HASIL AKHIR rowsForDate:", rows);
  return rows;
}

function wbFromRows(rows, sheetName = "LAPORAN"){
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return wb;
}

function downloadBlobFile(blob, filename){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ===== EXPORT HARIAN (ZIP UNTUK ADMIN/PIKET, EXCEL UNTUK WALI) =====
function exportDaily(scope, kelasLocked = null){
  setLoading(true, "Menyiapkan laporan harian...");
  try {
    const today = todayId();
    console.log("📅 Export Daily - Tanggal:", today);
    
    const rows = rowsForDate(today, scope, kelasLocked);
    console.log("📊 Data rows:", rows);
    
    if (rows.length === 0) {
      toast("Tidak ada data presensi untuk hari ini!");
      setLoading(false);
      return;
    }
    
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, `HARIAN ${today}`);
    
    const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const filename = scope === "class" 
      ? `LAPORAN_HARIAN_${kelasLocked}_${today.replace(/\//g, "-")}.xlsx`
      : `LAPORAN_HARIAN_ALL_${today.replace(/\//g, "-")}.xlsx`;
    
    downloadBlobFile(new Blob([arr]), filename);
    toast("✅ Export harian berhasil!");
  } catch (e) {
    console.error("❌ Gagal export daily:", e);
    toast("Gagal export: " + e.message);
  } finally {
    setLoading(false);
  }
}

async function exportDailyZip(scope, kelasLocked = null) {
  setLoading(true, "Membuat ZIP laporan harian...");
  try {
    const zip = new JSZip();
    const today = todayId();
    
    let kelasList = [];
    if (scope === "class" && kelasLocked) {
      kelasList = [kelasLocked];
    } else {
      kelasList = DAFTAR_KELAS;
    }
    
    let totalFiles = 0;
    
    for (const kelas of kelasList) {
      const rows = rowsForDate(today, "class", kelas);
      console.log(`Kelas ${kelas}: ${rows.length} data`);
      
      if (rows.length > 0) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, `HARIAN ${kelas}`);
        
        const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
        zip.file(`${kelas}/LAPORAN_HARIAN_${kelas}_${today.replace(/\//g, "-")}.xlsx`, arr);
        totalFiles++;
      }
    }
    
    if (totalFiles === 0) {
      toast("Tidak ada data presensi hari ini!");
      setLoading(false);
      return;
    }
    
    const content = await zip.generateAsync({ type: "blob" });
    const filename = scope === "class" 
      ? `LAPORAN_HARIAN_${kelasLocked}_${today.replace(/\//g, "-")}.zip`
      : `LAPORAN_HARIAN_ALL_${today.replace(/\//g, "-")}.zip`;
    
    downloadBlobFile(content, filename);
    toast(`✅ ZIP berhasil dibuat (${totalFiles} kelas)!`);
  } catch (e) {
    console.error("❌ Gagal buat ZIP:", e);
    toast("Gagal buat ZIP: " + e.message);
  } finally {
    setLoading(false);
  }
}

// ===== FUNGSI UNTUK EXPORT TOTAL (LANGSUNG DARI FIRESTORE) =====
async function exportTotalFromFirestore(scope, kelasLocked = null) {
  setLoading(true, "Mengambil data total dari server...");
  try {
    const db = firebase.firestore();
    const siswaMap = new Map();
    
    // Tentukan kelas yang mau diexport
    let kelasList = [];
    if (scope === "class" && kelasLocked) {
      kelasList = [kelasLocked];
    } else {
      kelasList = DAFTAR_KELAS;
    }
    
    // Ambil data dari Firestore untuk setiap kelas
    for (const kelas of kelasList) {
      const snapshot = await db.collection("kelas").doc(kelas).collection("siswa").get();
      
      snapshot.forEach(doc => {
        const siswa = doc.data();
        const key = `${kelas}_${siswa.Absen}`;
        
        siswaMap.set(key, {
          Nama: siswa.Nama || "-",
          Kelas: siswa.Kelas || "-",
          Absen: siswa.Absen || "-",
          JK: siswa.JK || "-",
          Agama: siswa.Agama || "-",
          NoHP: siswa.NoHP || "-",
          Hadir: siswa.Hadir || 0,
          Izin: siswa.Izin || 0,
          Sakit: siswa.Sakit || 0,
          Alpa: siswa.Alpa || 0,
          Terlambat: siswa.Terlambat || 0,
          Dispen: siswa.Dispen || 0,
          PulangCepat: siswa.PulangCepat || 0
        });
      });
    }
    
    // Convert Map ke Array
    const rows = [];
    siswaMap.forEach(data => {
      const totalHari = data.Hadir + data.Izin + data.Sakit + data.Alpa;
      const persentase = totalHari > 0 ? ((data.Hadir / totalHari) * 100).toFixed(2) : 0;
      
      rows.push({
        "Nama": data.Nama,
        "Kelas": data.Kelas,
        "Absen": data.Absen,
        "JK": data.JK,
        "Agama": data.Agama,
        "No HP": data.NoHP,
        "Hadir": data.Hadir,
        "Izin": data.Izin,
        "Sakit": data.Sakit,
        "Alpa": data.Alpa,
        "Terlambat": data.Terlambat,
        "Dispen": data.Dispen,
        "Pulang Cepat": data.PulangCepat,
        "Total Hari": totalHari,
        "Persentase Hadir": `${persentase}%`
      });
    });
    
    // Sort by Kelas, then Absen
    rows.sort((a, b) => {
      if (a.Kelas !== b.Kelas) return a.Kelas.localeCompare(b.Kelas);
      return parseInt(a.Absen) - parseInt(b.Absen);
    });
    
    // Buat summary
    let totalHadir = 0, totalIzin = 0, totalSakit = 0, totalAlpa = 0;
    let totalTerlambat = 0, totalDispen = 0, totalPulang = 0;
    
    rows.forEach(row => {
      totalHadir += row.Hadir;
      totalIzin += row.Izin;
      totalSakit += row.Sakit;
      totalAlpa += row.Alpa;
      totalTerlambat += row.Terlambat;
      totalDispen += row.Dispen;
      totalPulang += row["Pulang Cepat"];
    });
    
    const totalHariAll = totalHadir + totalIzin + totalSakit + totalAlpa;
    const rataKehadiran = totalHariAll > 0 ? ((totalHadir / totalHariAll) * 100).toFixed(2) : 0;
    
    const summary = [
      { "Metric": "Total Siswa", "Value": rows.length },
      { "Metric": "Total Kehadiran", "Value": totalHadir },
      { "Metric": "Total Izin", "Value": totalIzin },
      { "Metric": "Total Sakit", "Value": totalSakit },
      { "Metric": "Total Alpa", "Value": totalAlpa },
      { "Metric": "Total Terlambat", "Value": totalTerlambat },
      { "Metric": "Total Dispen", "Value": totalDispen },
      { "Metric": "Total Pulang Cepat", "Value": totalPulang },
      { "Metric": "Total Hari (semua siswa)", "Value": totalHariAll },
      { "Metric": "Rata-rata Kehadiran", "Value": `${rataKehadiran}%` }
    ];
    
    // Buat Excel
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "STATISTIK TOTAL");
    
    const wsSummary = XLSX.utils.json_to_sheet(summary);
    XLSX.utils.book_append_sheet(wb, wsSummary, "RINGKASAN");
    
    // Download
    const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const filename = scope === "class" 
      ? `STATISTIK_TOTAL_${kelasLocked}_${todayId().replace(/\//g, "-")}.xlsx`
      : `STATISTIK_TOTAL_ALL_${todayId().replace(/\//g, "-")}.xlsx`;
    
    downloadBlobFile(new Blob([arr]), filename);
    toast("Export total berhasil ✅");
    
  } catch (e) {
    console.error("Gagal export total:", e);
    toast("Gagal mengambil data dari server: " + e.message);
  } finally {
    setLoading(false);
  }
}

// ===== EXPORT TOTAL UNTUK WALI (EXCEL LANGSUNG) =====
async function exportTotalWali() {
  if (!session.kelas) return toast("Kelas tidak ditemukan!");
  await exportTotalFromFirestore("class", session.kelas);
}

// ===== EXPORT TOTAL UNTUK ADMIN/PIKET (ZIP) =====
async function exportTotalAllZip() {
  setLoading(true, "Membuat ZIP total semua kelas...");
  try {
    const zip = new JSZip();
    
    for (const kelas of DAFTAR_KELAS) {
      // Ambil data per kelas dari Firestore
      const db = firebase.firestore();
      const snapshot = await db.collection("kelas").doc(kelas).collection("siswa").get();
      
      const rows = [];
      snapshot.forEach(doc => {
        const s = doc.data();
        const totalHari = (s.Hadir || 0) + (s.Izin || 0) + (s.Sakit || 0) + (s.Alpa || 0);
        const persentase = totalHari > 0 ? ((s.Hadir || 0) / totalHari * 100).toFixed(2) : 0;
        
        rows.push({
          "Nama": s.Nama || "-",
          "Kelas": s.Kelas || "-",
          "Absen": s.Absen || "-",
          "JK": s.JK || "-",
          "Agama": s.Agama || "-",
          "No HP": s.NoHP || "-",
          "Hadir": s.Hadir || 0,
          "Izin": s.Izin || 0,
          "Sakit": s.Sakit || 0,
          "Alpa": s.Alpa || 0,
          "Terlambat": s.Terlambat || 0,
          "Dispen": s.Dispen || 0,
          "Pulang Cepat": s.PulangCepat || 0,
          "Total Hari": totalHari,
          "Persentase Hadir": `${persentase}%`
        });
      });
      
      if (rows.length > 0) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, `TOTAL ${kelas}`);
        const arr = XLSX.write(wb, { bookType: "xlsx", type: "array" });
        zip.file(`${kelas}/STATISTIK_TOTAL_${kelas}.xlsx`, arr);
      }
    }
    
    const content = await zip.generateAsync({ type: "blob" });
    downloadBlobFile(content, `STATISTIK_TOTAL_ALL_${todayId().replace(/\//g, "-")}.zip`);
    toast("ZIP total berhasil dibuat ✅");
  } catch (e) {
    console.error(e);
    toast("Gagal buat ZIP total");
  } finally {
    setLoading(false);
  }
}
/* ===================== END EXPORT ===================== */

/* ===================== MANAJEMEN DATA ===================== */

async function resetAllData() {
  if (session.role !== "admin") {
    return toast("Hanya admin yang bisa reset semua data!");
  }
  const konfirmasi = confirm(`⚠️ RESET SEMUA DATA ⚠️\n\nYang akan dihapus/reset:\n• Semua data siswa\n• Semua statistik presensi\n• Semua event harian (dispen/pulang cepat/terlambat)\n• Semua absensi pelajaran\n• Semua jadwal piket\n• Semua akun selain admin default\n\nAksi ini TIDAK BISA dibatalkan!\n\nLanjutkan?`);

  if (!konfirmasi) return;

  const password = prompt("Masukkan password admin untuk konfirmasi:");
  if (!validateCurrentAdminPassword(password)) {
    return toast("Password admin salah!");
  }

  setLoading(true, "Menghapus semua data...");

  try {
    const db = firebase.firestore();

    settings = {
      lateCutoff: "06:30",
      alpaCutoff: "08:00"
    };

    accountsDB = defaultAccounts().map(applyAccountRules);
    picketScheduleDB = emptyPicketSchedule();
    teacherAttendanceDB = [];
    localDB = {};
    ensureBuckets();

    for (const kelas of DAFTAR_KELAS) {
      await syncClassToFirestore(kelas);
    }

    await deleteSnapshotDocs(await db.collection("teacherAttendance").get(), db);
    await clearDailyEventsFromFirestore();
    await deleteSnapshotDocs(await db.collection("notificationTokens").get(), db);

    await db.collection("settings").doc("global").set(settings);
    await db.collection("settings").doc("accounts").set({
      accounts: accountsDB.map(applyAccountRules),
      updatedAt: new Date().toISOString()
    });
    await db.collection("settings").doc("picketSchedule").set({
      days: picketScheduleDB,
      updatedAt: Date.now()
    });

    localStorage.clear();
    saveCacheDB();
    saveAccountsCache();
    savePicketScheduleCache();
    saveTeacherAttendanceCache();

    toast("✅ SEMUA DATA BERHASIL DI-RESET!");

    setTimeout(() => {
      window.location.reload();
    }, 1500);

  } catch (e) {
    console.error("Gagal reset all data:", e);
    toast("Gagal reset all data: " + e.message);
  } finally {
    setLoading(false);
  }
}

async function resetStatistik() {

  if (session.role !== "admin") {
    return toast("Hanya admin yang bisa reset statistik!");
  }

  const konfirmasi = confirm(
    "⚠️ RESET STATISTIK ⚠️\n\n" +
    "DATA SISWA TETAP ADA, tapi:\n" +
    "• Hadir → 0\n" +
    "• Izin → 0\n" +
    "• Sakit → 0\n" +
    "• Alpa → 0\n" +
    "• Terlambat → 0\n" +
    "• Dispen → 0\n" +
    "• Pulang Cepat → 0\n\n" +
    "Lanjutkan?"
  );

  if (!konfirmasi) return;

  const password = prompt("Masukkan password admin:");
  if (!validateCurrentAdminPassword(password)) {
    return toast("Password salah!");
  }

  setLoading(true, "Mereset statistik...");

  try {
    for (const kelas of DAFTAR_KELAS) {
      if (localDB[kelas] && localDB[kelas].length > 0) {
        localDB[kelas] = localDB[kelas].map(siswa => ({
          ...siswa,
          Hadir: 0,
          Izin: 0,
          Sakit: 0,
          Alpa: 0,
          Terlambat: 0,
          Dispen: 0,
          PulangCepat: 0,
          Jam: "-",
          JamTerlambat: "-",
          Tanggal: "-",
          Status: "-",
          Catatan: "-"
        }));
      }
    }

    clearLocalDailyEvents();
    await clearDailyEventsFromFirestore();

    saveCacheDB();
    for (const kelas of DAFTAR_KELAS) {
      await syncClassToFirestore(kelas);
    }

    toast("✅ STATISTIK BERHASIL DI-RESET!");
    renderAll();

  } catch (e) {
    console.error("Gagal reset statistik:", e);
    toast("Gagal reset statistik: " + e.message);
  } finally {
    setLoading(false);
  }
}

async function hapusSiswa(kelas, absen) {
  if (session.role !== "admin" && !(session.role === "guru" && session.isWaliKelas)) {
    return toast("Hanya admin & wali kelas yang bisa hapus siswa!");
  }

  if (session.role === "guru" && session.isWaliKelas && session.kelas !== kelas) {
    return toast("Anda hanya bisa menghapus siswa di kelas wali Anda!");
  }

  const siswa = findStudentByKelasAbsen(kelas, absen);
  if (!siswa) return toast("Siswa tidak ditemukan!");

  const konfirmasi = confirm(
    `⚠️ HAPUS SISWA ⚠️\n\n` +
    `Nama: ${siswa.Nama}\n` +
    `Kelas: ${kelas}\n` +
    `Absen: ${absen}\n\n` +
    `Data siswa ini akan dihapus PERMANEN!\n\n` +
    `Lanjutkan?`
  );

  if (!konfirmasi) return;

  setLoading(true, "Menghapus siswa...");

  try {
    const index = localDB[kelas].findIndex(s => normalizeAbsen(s.Absen) === normalizeAbsen(absen));
    if (index !== -1) {
      localDB[kelas].splice(index, 1);
    }

    await syncClassToFirestore(kelas);
    await deleteStudentDailyEventsFromFirestore(kelas, absen);

    const prefix = 'ABSEN_DAILY_EVENTS_';
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    const skey = studentKey(kelas, absen);
    keys.forEach(key => {
      try {
        const daily = JSON.parse(localStorage.getItem(key) || '{}');
        if (daily?.terlambat?.[skey]) delete daily.terlambat[skey];
        if (daily?.dispen?.[skey]) delete daily.dispen[skey];
        if (daily?.pulangCepat?.[skey]) delete daily.pulangCepat[skey];
        localStorage.setItem(key, JSON.stringify({
          dispen: daily?.dispen || {},
          pulangCepat: daily?.pulangCepat || {},
          terlambat: daily?.terlambat || {}
        }));
      } catch {}
    });

    localDB[kelas] = sortStudentsAlpha(localDB[kelas] || []);
    saveCacheDB();
    toast(`✅ Siswa ${siswa.Nama} berhasil dihapus!`);
    renderAll();

  } catch (e) {
    console.error("Gagal hapus siswa:", e);
    toast("Gagal hapus siswa: " + e.message);
  } finally {
    setLoading(false);
  }
}

/* ===================== PIKET DISPEN ===================== */
function fillPiketDispenSelectors(){
  const selK = $("piket-dp-kelas");
  const selN = $("piket-dp-nama");
  if (!selK || !selN) return;

  selK.innerHTML = "";
  DAFTAR_KELAS.forEach(k => selK.innerHTML += `<option value="${k}">${k}</option>`);

  selK.onchange = () => {
    const k = selK.value;
    const list = (localDB[k] || []).slice().sort((a, b) => Number(a.Absen) - Number(b.Absen));
    selN.innerHTML = list.map(s => `<option value="${s.Absen}">${s.Absen} - ${safeUpper(s.Nama)}</option>`).join("");
  };

  selK.dispatchEvent(new Event("change"));
}

function renderPiketDispenPending(){
  const el = $("piket-dp-list");
  if (!el) return;

  const daily = getDailyEvents();
  const items = [];

  Object.keys(daily.dispen || {}).forEach(k => {
    const it = daily.dispen[k];
    if (!it) return;
    if (!it.back || it.back === "-") {
      const [kelas, absen] = k.split("#");
      const s = (localDB[kelas] || []).find(x => normalizeAbsen(x.Absen) === normalizeAbsen(absen));
      items.push({ kelas, absen, nama: s?.Nama || "-", out: it.out || "-", alasan: it.alasan || "-" });
    }
  });

  if (!items.length) {
    el.innerHTML = `<p class="text-center text-gray-600 py-6 italic text-[10px] uppercase">Tidak ada yang pending.</p>`;
    return;
  }

  el.innerHTML = items.map(it => `
    <div class="glass p-4 rounded-2xl">
      <div class="text-xs font-black text-white uppercase">${safeUpper(it.nama)}</div>
      <div class="text-[9px] text-gray-500 uppercase font-bold">
        ${it.kelas} • ABSEN ${it.absen} • Keluar ${it.out} • Alasan: ${it.alasan}
      </div>
      <button class="mt-3 px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-[10px] font-black uppercase tracking-widest"
        data-k="${it.kelas}" data-a="${it.absen}">
        Tandai Sudah Balik
      </button>
    </div>
  `).join("");

  el.querySelectorAll("button[data-k]").forEach(btn => {
    btn.onclick = () => {
      const k = btn.getAttribute("data-k");
      const a = btn.getAttribute("data-a");
      markBackDispen({ kelas: k, absen: a, backTime: nowTimeId() });
      renderPiketDispenPending();
      toast("Ditandai sudah balik ✅");
    };
  });
}

/* ===================== RENDER ===================== */
function setModePills(selector, mode){
  document.querySelectorAll(selector).forEach(btn => {
    const is = btn.getAttribute("data-mode") === mode;
    btn.classList.toggle("pill-active", is);
    btn.classList.toggle("pill-inactive", !is);
  });
}

function renderAll(){
  renderLogTo($("admin-log"), collectLogs("all"));
  renderLogTo($("wali-log"), collectLogs("class"));
  renderLogTo($("sek-log"), collectLogs("class"));
  renderLogTo($("piket-log"), collectLogs("all"));

  renderManualList($("admin-manual-list"), buildStudentList("all", $("admin-manual-search")?.value));
  renderManualList($("wali-manual-list"), buildStudentList("class", $("wali-manual-search")?.value));
  renderManualList($("sek-manual-list"), buildStudentList("class", $("sek-manual-search")?.value));
  renderManualList($("piket-manual-list"), buildStudentList("all", $("piket-manual-search")?.value));

  renderOrtuDashboard();

  setModePills(".mode-pill-admin", session.mode);
  setModePills(".mode-pill-wali", session.mode);
  setModePills(".mode-pill-sekretaris", session.mode);
  setModePills(".mode-pill-piket", session.mode);

  if ((session.role === "guru" && session.piketToday) || session.role === "admin") {
    fillPiketDispenSelectors();
    renderPiketDispenPending();
  }

  const notifBtn = $("btn-enable-notif");
  if (notifBtn) {
    if (session.role === "orangtua") notifBtn.classList.remove("hidden");
    else notifBtn.classList.add("hidden");
  }

  if (session.role === "admin") {
    renderAccounts();
    renderAdminStudentList();
    renderPicketScheduleAdmin();
  }

  if (session.role === "guru") {
    renderTeacherProfile();
    renderWaliEditList();
    if ($("wali-create-wrap")) $("wali-create-wrap").classList.add("hidden");
  }

  if (teacherCanUsePelajaran()) {
    renderPelajaranPanel();
  }
}



function getPicketDaysForUser(username){
  const result=[]; const src=picketScheduleDB||{};
  Object.entries(src).forEach(([day,arr])=>{ if((arr||[]).includes(username)) result.push(day.toUpperCase()); });
  return result;
}

function renderTeacherProfile(){
  if (session.role !== "guru") return;
  setText("profile-name", session.displayName || session.username || "-");
  setText("profile-nip", session.nip || "-");
  setText("profile-mengajar", (session.mengajar||[]).join(", ") || "-");
  setText("profile-piket", getPicketDaysForUser(session.username).join(", ") || "Tidak ada");
}

async function upsertStudentFromAdminForm({ nik, nisn, nis, nama, kelas, jenis, agama }){
  const kelasFix = normalizeClassName(kelas);
  const nikFix = normalizeNik(nik);
  if (!nikFix) throw new Error("NIK wajib diisi.");
  const existing = findStudentByNik(nikFix);
  if (existing) {
    const oldClass = existing.Kelas;
    const idx = (localDB[oldClass]||[]).findIndex(s => normalizeNik(s.NIK) === nikFix);
    if (idx < 0) throw new Error("Data siswa tidak ditemukan.");
    const updated = normalizeStudentRow({ ...existing, NIK: nikFix, NISN: nisn || existing.NISN, NIS: nis || existing.NIS, Nama: nama || existing.Nama, Kelas: kelasFix, Jenis: jenis || existing.Jenis, JK: jenis || existing.JK, Agama: agama || existing.Agama });
    if (oldClass !== kelasFix) {
      localDB[oldClass].splice(idx,1);
      updated.Absen = nextAbsenForClass(kelasFix);
      localDB[kelasFix].push(updated);
      await syncClassToFirestore(oldClass);
    } else {
      localDB[oldClass][idx] = updated;
    }
    saveCacheDB();
    await syncClassToFirestore(kelasFix);
    return updated;
  }
  await addStudent({ nama, kelas: kelasFix, absen: nextAbsenForClass(kelasFix), jk: jenis || 'L', agama: agama || 'Islam', nik: nikFix, nisn: nisn || '-', nis: nis || '-' });
}

function startEditStudentFromAdmin(nik){
  const s = findStudentByNik(nik); if (!s) return toast("Siswa tidak ditemukan.");
  if ($("acc-role")) $("acc-role").value = "siswa";
  if ($("acc-form-title")) $("acc-form-title").textContent = "Edit Data Siswa";
  if ($("acc-edit-index")) $("acc-edit-index").value = "STUDENT";
  if ($("acc-siswa-nik")) $("acc-siswa-nik").value = s.NIK || "";
  if ($("acc-siswa-nisn")) $("acc-siswa-nisn").value = s.NISN || "";
  if ($("acc-siswa-nis")) $("acc-siswa-nis").value = s.NIS || "";
  if ($("acc-siswa-nama")) $("acc-siswa-nama").value = s.Nama || "";
  populateAccountClassSelect();
  if ($("acc-siswa-kelas")) $("acc-siswa-kelas").value = s.Kelas || "";
  if ($("acc-siswa-jenis")) $("acc-siswa-jenis").value = s.Jenis || s.JK || "L";
  if ($("acc-siswa-agama")) $("acc-siswa-agama").value = s.Agama || "Islam";
  toggleAccountFieldVisibility();
}

function renderAdminStudentList(){
  const box = $("admin-student-list"); if (!box) return;
  const all=[]; DAFTAR_KELAS.forEach(k => (localDB[k]||[]).forEach(s => all.push(s)));
  all.sort((a,b)=> a.Kelas.localeCompare(b.Kelas) || Number(a.Absen)-Number(b.Absen));
  const preview = all.slice(0,40);
  box.innerHTML = `<div class="text-[10px] uppercase tracking-widest text-gray-400 font-bold">Data siswa tersimpan: ${all.length} • tampil ${preview.length} pertama</div>` + preview.map(s => `
    <div class="glass p-4 rounded-[1.5rem] flex items-center justify-between gap-3">
      <div><div class="text-xs font-black text-white uppercase">${safeUpper(s.Nama)}</div><div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">${s.Kelas} • ABSEN ${s.Absen} • NIK ${s.NIK || '-'} • NISN ${s.NISN || '-'} • NIS ${s.NIS || '-'}</div></div>
      <button class="admin-edit-student-btn px-4 py-2 rounded-xl border border-cyan-500/30 text-cyan-300 text-[10px] font-black uppercase tracking-widest" data-nik="${s.NIK || ''}">Edit</button>
    </div>`).join('');
  box.querySelectorAll('.admin-edit-student-btn').forEach(btn => btn.addEventListener('click', ()=> startEditStudentFromAdmin(btn.dataset.nik)));
}

function exportGuruDataExcel(){
  const rows = accountsDB.filter(a => a.role === 'guru').map(a => ({ Nama: a.displayName || a.username, Username: a.username, Password: a.password, Role: a.role, NIP: a.nip || '-', Mengajar: (a.mengajar||[]).join(', '), WaliKelas: a.isWaliKelas ? (a.waliKelas || '-') : '-', HariPiket: getPicketDaysForUser(a.username).join(', ') || '-' }));
  if (!rows.length) return toast('Belum ada data guru.');
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(rows); XLSX.utils.book_append_sheet(wb, ws, 'Guru');
  XLSX.writeFile(wb, `DATA_GURU_${todayId().replace(/\//g,'-')}.xlsx`);
}

function exportStudentExcel(){
  const rows=[]; DAFTAR_KELAS.forEach(k => (localDB[k]||[]).forEach(s => rows.push({ NIK:s.NIK||'', NISN:s.NISN||'', NIS:s.NIS||'', Nama:s.Nama, Kelas:s.Kelas, Jenis:s.Jenis||s.JK||'', Agama:s.Agama||'' })));
  if (!rows.length) return toast('Belum ada data siswa.');
  const wb = XLSX.utils.book_new(); const ws = XLSX.utils.json_to_sheet(rows); XLSX.utils.book_append_sheet(wb, ws, 'Siswa');
  XLSX.writeFile(wb, `DATA_SISWA_${todayId().replace(/\//g,'-')}.xlsx`);
}

function renderWaliEditList(){
  const box = $("wali-edit-list"); if (!box || !(session.role==='guru' && session.isWaliKelas && session.waliKelas)) return;
  const q = String($("wali-edit-search")?.value || '').toLowerCase().trim();
  let arr = (localDB[session.waliKelas] || []).slice().sort((a,b)=>Number(a.Absen)-Number(b.Absen));
  if (q) arr = arr.filter(s => `${s.Nama} ${s.NIK} ${s.Absen}`.toLowerCase().includes(q));
  box.innerHTML = arr.map(s => `<button class="w-full text-left glass p-3 rounded-xl wali-edit-item" data-nik="${s.NIK || ''}"><div class="text-xs font-black text-white uppercase">${safeUpper(s.Nama)}</div><div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">ABSEN ${s.Absen} • NIK ${s.NIK || '-'} • ${s.Kelas}</div></button>`).join('') || '<div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Belum ada siswa.</div>';
  box.querySelectorAll('.wali-edit-item').forEach(btn => btn.addEventListener('click', ()=>fillWaliStudentEditor(btn.dataset.nik)));
}

function fillWaliStudentEditor(nik){
  const s = findStudentByNik(nik); if (!s) return;
  $("wali-edit-nik").value = s.NIK || '';
  $("wali-edit-nisn").value = s.NISN || '';
  $("wali-edit-nis").value = s.NIS || '';
  $("wali-edit-nama").value = s.Nama || '';
  $("wali-edit-kelas").value = s.Kelas || '';
  $("wali-edit-jenis").value = s.Jenis || s.JK || 'L';
  $("wali-edit-agama").value = s.Agama || 'Islam';
}

async function saveWaliStudentEditor(){
  const nik = $("wali-edit-nik")?.value || ''; if (!nik) return toast('Pilih siswa dulu.');
  const s = findStudentByNik(nik); if (!s) return toast('Siswa tidak ditemukan.');
  const kelas = s.Kelas;
  const idx = (localDB[kelas]||[]).findIndex(x => normalizeNik(x.NIK)===normalizeNik(nik));
  if (idx < 0) return toast('Siswa tidak ditemukan.');
  localDB[kelas][idx] = normalizeStudentRow({ ...localDB[kelas][idx], NISN: $("wali-edit-nisn")?.value || '-', NIS: $("wali-edit-nis")?.value || '-', Nama: $("wali-edit-nama")?.value || localDB[kelas][idx].Nama, Kelas: kelas, Jenis: $("wali-edit-jenis")?.value || 'L', JK: $("wali-edit-jenis")?.value || 'L', Agama: $("wali-edit-agama")?.value || 'Islam' });
  saveCacheDB(); await syncClassToFirestore(kelas); renderAll(); toast('Data siswa diperbarui.');
}

/* ===================== BIND EVENTS ===================== */
function bindEvents(){
  $("btn-logout")?.addEventListener("click", doLogout);
  $("btn-enable-notif")?.addEventListener("click", enableParentNotification);

  $("btn-login-do")?.addEventListener("click", doLogin);
  $("btn-login-cancel")?.addEventListener("click", closeLogin);
  $("role-tabs-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab-target]");
    if (!btn) return;
    setRoleTab(btn.getAttribute("data-tab-target"));
  });
  $("acc-role")?.addEventListener("change", toggleAccountFieldVisibility);
  $("btn-account-save")?.addEventListener("click", saveAccountForm);
  $("btn-account-cancel")?.addEventListener("click", resetAccountForm);
  $("btn-download-guru-data")?.addEventListener("click", exportGuruDataExcel);
  $("btn-export-student-excel")?.addEventListener("click", exportStudentExcel);
  $("wali-edit-search")?.addEventListener("input", renderWaliEditList);
  $("btn-wali-update-student")?.addEventListener("click", saveWaliStudentEditor);
  $("btn-admin-student-bulk-import")?.addEventListener("click", handleAdminBulkStudentImportText);
  $("btn-admin-student-file-import")?.addEventListener("click", handleAdminBulkStudentImportFile);
  $("btn-admin-student-template")?.addEventListener("click", downloadTemplateBulkSiswa);
  $("btn-admin-student-qr-all")?.addEventListener("click", downloadAllStudentQrZip);
  $("btn-save-picket-schedule")?.addEventListener("click", savePicketScheduleFromForm);
  $("pelajaran-start-cam")?.addEventListener("click", () => startScanner("pelajaran"));
  $("pelajaran-stop-cam")?.addEventListener("click", () => stopScanner("pelajaran"));
  $("btn-pelajaran-start-session")?.addEventListener("click", startLessonSession);
  $("pelajaran-kelas")?.addEventListener("change", renderAll);
  $("pelajaran-search")?.addEventListener("input", renderAll);
  $("btn-pelajaran-export-daily")?.addEventListener("click", () => exportTeacherLessonZip("daily"));
  $("btn-pelajaran-export-rekap")?.addEventListener("click", () => exportTeacherLessonZip("rekap"));

  document.querySelectorAll(".mode-pill").forEach(btn => {
    btn.addEventListener("click", () => {
      session.mode = btn.getAttribute("data-mode");
      saveSession();
      renderAll();
    });
  });

  $("admin-start-cam")?.addEventListener("click", () => startScanner("admin"));
  $("admin-stop-cam")?.addEventListener("click", () => stopScanner("admin"));

  $("wali-start-cam")?.addEventListener("click", () => startScanner("wali"));
  $("wali-stop-cam")?.addEventListener("click", () => stopScanner("wali"));

  $("sekretaris-start-cam")?.addEventListener("click", () => startScanner("sekretaris"));
  $("sekretaris-stop-cam")?.addEventListener("click", () => stopScanner("sekretaris"));

  $("piket-start-cam")?.addEventListener("click", () => startScanner("piket"));
  $("piket-stop-cam")?.addEventListener("click", () => stopScanner("piket"));

  $("admin-refresh-log")?.addEventListener("click", renderAll);
  $("wali-refresh-log")?.addEventListener("click", renderAll);
  $("sek-refresh-log")?.addEventListener("click", renderAll);
  $("piket-refresh-log")?.addEventListener("click", renderAll);

  $("admin-manual-search")?.addEventListener("input", renderAll);
  $("wali-manual-search")?.addEventListener("input", renderAll);
  $("sek-manual-search")?.addEventListener("input", renderAll);
  $("piket-manual-search")?.addEventListener("input", renderAll);

  $("btn-save-settings")?.addEventListener("click", saveSettingsToFirestore);
  $("btn-admin-sync")?.addEventListener("click", syncAllToFirestore);

  // EXPORT UNTUK ADMIN/PIKET
$("btn-export-daily-all")?.addEventListener("click", () => exportDailyZip("all"));
$("btn-export-alltime")?.addEventListener("click", exportTotalAllZip);

// EXPORT UNTUK WALI KELAS
$("btn-wali-export-daily")?.addEventListener("click", () => { 
  if (session.kelas) exportDaily("class", session.kelas); 
});
$("btn-wali-export-alltime")?.addEventListener("click", exportTotalWali);

// EXPORT UNTUK PIKET (sama kayak admin)
$("btn-piket-export-daily")?.addEventListener("click", () => exportDailyZip("all"));
$("btn-piket-export-alltime")?.addEventListener("click", exportTotalAllZip);

  // TOMBOL RESET
  $("btn-reset-all")?.addEventListener("click", resetAllData);
  $("btn-reset-statistik")?.addEventListener("click", resetStatistik);

  $("btn-wali-create-qr")?.addEventListener("click", async () => {
    if (!(session.role === "guru" && session.isWaliKelas)) return toast("Akses ditolak.");
    const kelas = session.kelas;
    const nama = $("wali-nama")?.value.trim();
    const absen = normalizeAbsen($("wali-absen")?.value);
    const jk = $("wali-jk")?.value;
    const agama = $("wali-agama")?.value;
    const phone = $("wali-phone")?.value.trim();

    try {
      setLoading(true, "Menyimpan data...");
      await addStudent({ nama, kelas, absen, jk, agama, phone });
      renderSingleQR($("wali-qr-result"), { nama, kelas, absen, jk, agama, nik: "" });

      if ($("wali-nama")) $("wali-nama").value = "";
      if ($("wali-absen")) $("wali-absen").value = "";
      if ($("wali-phone")) $("wali-phone").value = "";
      if ($("wali-jk")) $("wali-jk").value = "L";
      if ($("wali-agama")) $("wali-agama").value = "Islam";

      renderAll();
    } catch (e) {
      toast(e.message || "Gagal.");
    } finally {
      setLoading(false);
    }
  });

  $("btn-wali-bulk")?.addEventListener("click", async () => {
    if (!(session.role === "guru" && session.isWaliKelas)) return toast("Akses ditolak.");
    await bulkProcessAndZipForClass(session.kelas, $("wali-bulk")?.value);
    renderAll();
  });

  $("btn-piket-dp-save")?.addEventListener("click", () => {
  const kelas = $("piket-dp-kelas")?.value;
  const absen = $("piket-dp-nama")?.value;
  const jenis = $("piket-dp-jenis")?.value;
  const waktu = $("piket-dp-waktu")?.value || nowTimeId();
  const alasan = $("piket-dp-alasan")?.value.trim();

  if (!alasan) return toast("Alasan wajib.");

  if (jenis === "DISPEN") {
    upsertDispen({ kelas, absen, waktu, alasan });
    setText("piket-dp-info", `✅ Dispen tersimpan: ${kelas} ABSEN ${absen}`);
  } else {
    setPulangCepat({ kelas, absen, waktu, alasan });
    setText("piket-dp-info", `✅ Pulang cepat tersimpan: ${kelas} ABSEN ${absen}`);
  }

  $("piket-dp-alasan").value = "";
  $("piket-dp-waktu").value = "";
  renderPiketDispenPending();
  renderAll();
});

  $("btn-piket-dp-back")?.addEventListener("click", () => {
    const kelas = $("piket-dp-kelas")?.value;
    const absen = $("piket-dp-nama")?.value;
    const ok = markBackDispen({ kelas, absen, backTime: nowTimeId() });
    if (!ok) return toast("Belum ada data dispen siswa ini hari ini.");
    setText("piket-dp-info", `Ditandai sudah balik: ${kelas} ABSEN ${absen}`);
    renderPiketDispenPending();
    renderAll();
  });

  $("btn-piket-dp-refresh")?.addEventListener("click", renderPiketDispenPending);

  $("ma-close")?.addEventListener("click", closeActionModal);
  $("ma-reset")?.addEventListener("click", resetActionModalInputs);
  document.querySelectorAll(".ma-status").forEach(btn => {
    btn.addEventListener("click", () => setChosenStatus(btn.getAttribute("data-status")));
  });

  $("ma-save")?.addEventListener("click", async () => {
    const kelas = modalTarget.kelas;
    const absen = modalTarget.absen;
    const status = modalTarget.chosenStatus || "HADIR";
    const jam = $("ma-time")?.value || null;
    const note = $("ma-note")?.value || null;
    const disOut = $("ma-dispen-out")?.value || null;
    const disBack = $("ma-dispen-back")?.value || null;
    const early = $("ma-early")?.value || null;

    setLoading(true, "Menyimpan...");
    try {
      const r = await markAttendance({ kelas, absen, status, jamOverride: jam, note });
      if (!r.ok) {
        toast(r.msg || 'Gagal simpan absensi.');
        return;
      }

      if (disOut) {
        upsertDispen({ kelas, absen, waktu: disOut, alasan: note || "-" });
      }
      if (disBack) {
        markBackDispen({ kelas, absen, backTime: disBack });
      }
      if (early) {
        setPulangCepat({ kelas, absen, waktu: early, alasan: note || "-" });
      }

      toast(r.edited ? "Tersimpan (Edit) ✅" : "Tersimpan ✅");
      closeActionModal();
      renderAll();
    } catch (e) {
      console.error(e);
      toast("Gagal simpan.");
    } finally {
      setLoading(false);
    }
  });

  window.addEventListener("beforeunload", () => stopAllScanners());
}

/* ===================== INIT ===================== */
async function init(){
  setText("app-title", CONFIG.SCHOOL_NAME);
  fillLoginClassSelect();
  populateAccountClassSelect();
  restoreAccountsCache();
  resetAccountForm();
  
  // TAMPILKAN DATA DARI CACHE DULU (CEPET, LANGSUNG MUNCUL)
  restoreCacheDB();
  ensureBuckets();
  migrateStudentsSchema();
  renderAll(); // <-- DATA CACHE LANGSUNG MUNCUL
  
  restoreSession();
  onRoleChange();

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch (e) {
      console.error("SW gagal:", e);
    }
  }

  // LOADING MUNCUL
  setLoading(true, "Sinkronisasi Database...");
  
  // AMBIL DATA BARU DARI FIRESTORE (SISWA)
  try {
    const db = firebase.firestore();
    for (const kelas of DAFTAR_KELAS) {
      const snapshot = await db.collection("kelas").doc(kelas).collection("siswa").get();
      localDB[kelas] = [];
      snapshot.forEach(doc => {
        localDB[kelas].push(normalizeStudentRow(doc.data()));
      });
    }
    
    const settingsDoc = await db.collection("settings").doc("global").get();
    if (settingsDoc.exists) {
      settings = { ...settings, ...settingsDoc.data() };
    }

    await loadAccountsFromFirestore();
    await loadPicketScheduleFromFirestore();
    await loadTeacherAttendanceFromFirestore();
    
    ensureBuckets();
    migrateStudentsSchema();
    resequenceAllClasses();
    saveCacheDB();
    
    await subscribeToAllClasses();
    
  } catch (e) {
    console.error("Gagal load Firestore:", e);
    toast("Gagal sinkron database. Pakai data lokal.");
  }

  // ===== TAMBAH: LOAD DISPEN/PULANG/TERLAMBAT DARI FIRESTORE =====
  const today = todayId();
  await loadDispenFromFirestore(today);
  await loadPulangCepatFromFirestore(today);
  await loadTerlambatFromFirestore(today);

  if ($("set-late")) $("set-late").value = settings.lateCutoff;
  if ($("set-alpa")) $("set-alpa").value = settings.alpaCutoff;

  bindEvents();

  if (session.role) {
    session.piketToday = isScheduledPicketToday(session.username);
    activeRoleTab = null;
    setBadge();
    show("btn-logout");
    showRoleView();
  } else {
    openLogin();
  }

  // RENDER DATA FIRESTORE + DISPEN
  renderAll();
  
  // MATIKAN LOADING
  setLoading(false);

  startParentWatcher();
}

window.onload = init;


/* ===================== PATCH TOTAL CLEANUP ===================== */
let activeAdminTab = 'admin-panel-overview';

function sortStudentsAlpha(arr){
  return arr.slice().sort((a,b)=> String(a.Nama||'').localeCompare(String(b.Nama||''), 'id', { sensitivity:'base' }) || normalizeNik(a.NIK).localeCompare(normalizeNik(b.NIK)));
}
function resequenceClassAlphabetical(kelas){
  ensureBuckets();
  localDB[kelas] = sortStudentsAlpha((localDB[kelas] || []).map(s => ({ ...s, Kelas: kelas })));
}
function resequenceAllClasses(){ DAFTAR_KELAS.forEach(resequenceClassAlphabetical); saveCacheDB(); }
function classSortKeyV4(kelas){
  const raw = String(kelas || '').trim().toUpperCase();
  const m = raw.match(/^(XII|XI|X)-?(\d+)$/);
  if (!m) return [99, raw, 999];
  const gradeOrder = { X: 1, XI: 2, XII: 3 };
  return [gradeOrder[m[1]] || 99, m[1], Number(m[2] || 0)];
}

function sortClassNamesV4(list){
  return Array.from(new Set((list || []).map(x => normalizeClassTokenV4(x)).filter(Boolean)))
    .sort((a, b) => {
      const ak = classSortKeyV4(a);
      const bk = classSortKeyV4(b);
      if (ak[0] !== bk[0]) return ak[0] - bk[0];
      if (ak[1] !== bk[1]) return String(ak[1]).localeCompare(String(bk[1]), 'id', { sensitivity: 'base' });
      if (ak[2] !== bk[2]) return ak[2] - bk[2];
      return String(a).localeCompare(String(b), 'id', { numeric: true, sensitivity: 'base' });
    });
}

function classesSorted(){
  return sortClassNamesV4(DAFTAR_KELAS);
}
function adminStudentSelectedClass(){ return normalizeClassName($('admin-student-class-picker')?.value || DAFTAR_KELAS[0]); }
function studentFormReset(){
  if ($('student-form-title')) $('student-form-title').textContent='Tambah Data Siswa';
  if ($('student-nik')) $('student-nik').readOnly = false;
  ['student-edit-nik','student-nik','student-nisn','student-nis','student-nama','student-agama'].forEach(id=>{ if($(id)) $(id).value = id==='student-agama' ? 'Islam' : ''; });
  if ($('student-kelas')) $('student-kelas').value = adminStudentSelectedClass();
  if ($('student-jenis')) $('student-jenis').value = 'L';
  if ($('admin-student-qr-result')) $('admin-student-qr-result').innerHTML='';
}
function populateStudentClassSelects(){
  const options = classesSorted();
  ['student-kelas', 'admin-student-class-picker', 'pelajaran-kelas', 'piket-dp-kelas'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const current = normalizeClassTokenV4(el.value || '');
    const placeholder = id === 'pelajaran-kelas' ? 'Pilih kelas...' : 'Pilih kelas';
    el.innerHTML = (id === 'admin-student-class-picker' ? '' : `<option value="">${placeholder}</option>`) + options.map(k => `<option value="${k}">${k}</option>`).join('');
    if (current && options.includes(current)) el.value = current;
    else if (id === 'admin-student-class-picker' && options[0]) el.value = options[0];
  });
}
function normalizeAccount(acc){
  const out = {
    username: String(acc?.username || '').trim(),
    password: String(acc?.password || ''),
    role: String(acc?.role || '').trim(),
    kelas: acc?.kelas ? String(acc.kelas).trim() : null,
    displayName: String(acc?.displayName || acc?.username || '').trim(),
    nip: String(acc?.nip || '').trim(),
    mengajar: Array.isArray(acc?.mengajar) ? acc.mengajar.map(x => normalizeClassTokenV4(x)).filter(Boolean) : String(acc?.mengajar || '').split(',').map(x => normalizeClassTokenV4(x)).filter(Boolean),
    parentAbsen: acc?.parentAbsen ? normalizeAbsen(acc.parentAbsen) : null,
    parentPhone: acc?.parentPhone ? normalizePhone(acc.parentPhone) : null,
    isWaliKelas: !!(acc?.isWaliKelas || acc?.waliKelas?.enabled),
    waliKelas: acc?.waliKelas?.kelas ? String(acc.waliKelas.kelas).trim() : (acc?.waliKelas ? String(acc.waliKelas).trim() : null)
  };
  if (out.role !== 'guru') { out.isWaliKelas = false; out.waliKelas = null; out.nip=''; out.mengajar=[]; }
  if (out.role === 'guru' && out.isWaliKelas && out.waliKelas && !out.mengajar.includes(normalizeClassName(out.waliKelas))) out.mengajar.push(normalizeClassName(out.waliKelas));
  if (out.role !== 'orangtua') { out.kelas=null; out.parentAbsen=null; out.parentPhone=null; }
  return out;
}
function toggleAccountFieldVisibility(){
  const role = $('acc-role')?.value || 'admin';
  $('acc-guru-wrap')?.classList.toggle('hidden', role !== 'guru');
  $('acc-guru-extra-wrap')?.classList.toggle('hidden', role !== 'guru');
  $('acc-kelas-wrap')?.classList.toggle('hidden', role !== 'orangtua');
  $('acc-absen-wrap')?.classList.toggle('hidden', role !== 'orangtua');
  $('acc-hp-wrap')?.classList.toggle('hidden', role !== 'orangtua');
}
function resetAccountForm(){
  if ($('acc-form-title')) $('acc-form-title').textContent = 'Buat Akun Guru / Orang Tua';
  if ($('acc-edit-index')) $('acc-edit-index').value = '';
  ['acc-name','acc-username','acc-password','acc-guru-nip','acc-guru-mengajar','acc-wali-kelas','acc-absen','acc-hp'].forEach(id=>{ if($(id)) $(id).value=''; });
  if ($('acc-role')) $('acc-role').value='guru';
  if ($('acc-kelas')) $('acc-kelas').value='';
  if ($('acc-is-wali')) $('acc-is-wali').checked=false;
  if ($('btn-account-save')) $('btn-account-save').textContent='Simpan Akun';
  toggleAccountFieldVisibility();
}
function startEditAccount(index){
  const acc = accountsDB[index]; if(!acc) return;
  if ($('acc-form-title')) $('acc-form-title').textContent = 'Edit Akun';
  if ($('acc-edit-index')) $('acc-edit-index').value = String(index);
  if ($('acc-name')) $('acc-name').value = acc.displayName || '';
  if ($('acc-username')) $('acc-username').value = acc.username || '';
  if ($('acc-password')) $('acc-password').value = acc.password || '';
  if ($('acc-role')) $('acc-role').value = acc.role || 'guru';
  if ($('acc-guru-nip')) $('acc-guru-nip').value = acc.nip || '';
  if ($('acc-guru-mengajar')) $('acc-guru-mengajar').value = (acc.mengajar || []).join(', ');
  if ($('acc-is-wali')) $('acc-is-wali').checked = !!acc.isWaliKelas;
  if ($('acc-wali-kelas')) $('acc-wali-kelas').value = acc.waliKelas || '';
  if ($('acc-kelas')) $('acc-kelas').value = acc.kelas || '';
  if ($('acc-absen')) $('acc-absen').value = acc.parentAbsen || '';
  if ($('acc-hp')) $('acc-hp').value = acc.parentPhone || '';
  if ($('btn-account-save')) $('btn-account-save').textContent='Update Akun';
  toggleAccountFieldVisibility();
  setAdminTab('admin-panel-accounts');
}
function renderAccounts(){
  const box=$('account-list'); if(!box) return;
  const rows = accountsDB.slice().sort((a,b)=> String(a.displayName||a.username).localeCompare(String(b.displayName||b.username),'id',{sensitivity:'base'}));
  box.innerHTML = rows.map(acc=>{
    const idx = accountsDB.findIndex(x=>x.username===acc.username);
    const meta = [acc.role.toUpperCase(), acc.nip?`NIP ${acc.nip}`:null, (acc.mengajar||[]).length?`NGAJAR ${acc.mengajar.join(', ')}`:null, acc.isWaliKelas&&acc.waliKelas?`WALI ${acc.waliKelas}`:null, acc.role==='orangtua'&&acc.kelas?`KELAS ${acc.kelas}`:null].filter(Boolean).join(' • ');
    return `<div class="glass p-4 rounded-[1.75rem] flex flex-col md:flex-row md:items-center md:justify-between gap-3"><div><div class="text-xs font-black uppercase tracking-widest text-white">${acc.displayName||acc.username}</div><div class="text-[10px] uppercase tracking-widest text-cyan-300 font-bold mt-1">@${acc.username}</div><div class="text-[10px] uppercase tracking-widest text-gray-400 font-bold mt-2">${meta}</div></div><div class="flex gap-2"><button onclick="startEditAccount(${idx})" class="px-4 py-2 rounded-xl border border-cyan-500/30 text-cyan-300 text-[10px] font-black uppercase tracking-widest">Edit</button><button onclick="deleteAccount(${idx})" class="px-4 py-2 rounded-xl border border-red-500/30 text-red-400 text-[10px] font-black uppercase tracking-widest">Hapus</button></div></div>`;
  }).join('') || '<div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Belum ada akun.</div>';
}
async function saveAccountForm(){
  if (session.role !== 'admin') return toast('Hanya admin yang bisa mengelola akun.');
  const editIndex = $('acc-edit-index')?.value ?? '';
  const role = String($('acc-role')?.value || '').trim();
  const username = String($('acc-username')?.value || '').trim();
  const password = String($('acc-password')?.value || '').trim();
  const displayName = String($('acc-name')?.value || '').trim();
  const kelas = String($('acc-kelas')?.value || '').trim();
  const parentAbsen = String($('acc-absen')?.value || '').trim();
  const parentPhone = String($('acc-hp')?.value || '').trim();
  const nip = String($('acc-guru-nip')?.value || '').trim();
  const mengajar = String($('acc-guru-mengajar')?.value || '').split(/[;,\n]+/).map(x=>normalizeClassName(x)).filter(Boolean);
  const isWaliKelas = !!$('acc-is-wali')?.checked;
  const waliKelas = normalizeClassName($('acc-wali-kelas')?.value || '');
  if (!['admin','guru','orangtua'].includes(role)) return toast('Role akun tidak valid.');
  if (!username || !password || !displayName) return toast('Nama, username, dan password wajib diisi.');
  if (role === 'guru' && !nip) return toast('NIP guru wajib diisi.');
  if (role === 'guru' && !mengajar.length) return toast('Isi kelas yang diajar guru.');
  if (role === 'guru' && isWaliKelas && !waliKelas) return toast('Kelas wali wajib diisi.');
  if (role === 'orangtua' && (!kelas || !parentAbsen)) return toast('Kelas dan no absen anak wajib diisi.');
  const duplicate = accountsDB.findIndex(a => a.username.toLowerCase() === username.toLowerCase());
  if (duplicate >= 0 && String(duplicate) !== String(editIndex)) return toast('Username sudah dipakai.');
  const account = applyAccountRules({ username,password,role,displayName,kelas,parentAbsen,parentPhone,nip,mengajar,isWaliKelas,waliKelas });
  if (editIndex === '') accountsDB.push(account); else accountsDB[Number(editIndex)] = account;
  if (!accountsDB.some(a=>a.role==='admin')) return toast('Minimal harus ada 1 akun admin.');
  saveAccountsCache();
  try { setLoading(true,'Menyimpan akun...'); await saveAccountsToFirestore(); resetAccountForm(); renderAll(); toast('Akun berhasil disimpan.'); }
  catch(e){ toast('Gagal simpan akun: '+e.message); }
  finally { setLoading(false); }
}
async function cascadeDeleteTeacherData(acc){
  if (!acc || acc.role !== 'guru') return;
  const username = acc.username;
  const displayName = acc.displayName || acc.username;
  // remove picket schedule refs
  Object.keys(picketScheduleDB || {}).forEach(day => {
    picketScheduleDB[day] = (picketScheduleDB[day] || []).filter(x => x !== username);
  });
  savePicketScheduleCache();
  try { await savePicketScheduleToFirestore(); } catch(e) { console.warn(e); }
  // remove teacher attendance
  teacherAttendanceDB = (teacherAttendanceDB || []).filter(x => x.teacherUsername !== username);
  saveTeacherAttendanceCache();
  try {
    const db = firebase.firestore();
    const snap = await db.collection('teacherAttendance').where('teacherUsername','==',username).get();
    if (!snap.empty) {
      const batch = db.batch();
      snap.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
  } catch(e){ console.warn('Gagal hapus teacherAttendance firestore', e); }
  // clear stray references in students if any
  const touched=[];
  DAFTAR_KELAS.forEach(k=>{
    let changed=false;
    localDB[k] = (localDB[k]||[]).map(s=>{
      const cp={...s};
      ['Guru','NamaGuru','WaliGuru','waliName','teacherName','teacherUsername'].forEach(key=>{
        if (String(cp[key]||'') === username || String(cp[key]||'') === displayName) { cp[key]='-'; changed=true; }
      });
      return cp;
    });
    if (changed) { resequenceClassAlphabetical(k); touched.push(k); }
  });
  for (const k of touched) await syncClassToFirestore(k);
}
async function deleteAccount(index){
  if (session.role !== 'admin') return toast('Hanya admin yang bisa menghapus akun.');
  const acc = accountsDB[index]; if (!acc) return;
  const adminCount = accountsDB.filter(a => a.role === 'admin').length;
  if (acc.role === 'admin' && adminCount <= 1) return toast('Minimal 1 admin harus ada.');
  if (!confirm(`Hapus akun @${acc.username} dan semua data terkait?`)) return;
  accountsDB.splice(index,1); saveAccountsCache();
  try {
    setLoading(true,'Menghapus akun...');
    await cascadeDeleteTeacherData(acc);
    await saveAccountsToFirestore();
    resetAccountForm();
    renderAll();
    toast('Akun berhasil dihapus bersih.');
  } catch(e){ toast('Gagal hapus akun: '+e.message); }
  finally { setLoading(false); }
}
function startEditStudentFromAdmin(nik){
  const s = findStudentByNik(nik); if(!s) return toast('Siswa tidak ditemukan.');
  if ($('student-form-title')) $('student-form-title').textContent='Edit Data Siswa';
  if ($('student-edit-nik')) $('student-edit-nik').value = s.NIK || '';
  if ($('student-nik')) $('student-nik').value = s.NIK || '';
  if ($('student-nisn')) $('student-nisn').value = s.NISN || '';
  if ($('student-nis')) $('student-nis').value = s.NIS || '';
  if ($('student-nama')) $('student-nama').value = s.Nama || '';
  if ($('student-kelas')) $('student-kelas').value = s.Kelas || adminStudentSelectedClass();
  if ($('student-jenis')) $('student-jenis').value = s.Jenis || s.JK || 'L';
  if ($('student-agama')) $('student-agama').value = s.Agama || 'Islam';
  if ($('student-nik')) $('student-nik').readOnly = true;
  setAdminTab('admin-panel-students');
}
async function saveStudentForm(){
  const editNik = normalizeNik($('student-edit-nik')?.value || '');
  const nik = String($('student-nik')?.value || '').trim();
  const nisn = String($('student-nisn')?.value || '').trim();
  const nis = String($('student-nis')?.value || '').trim();
  const nama = String($('student-nama')?.value || '').trim();
  const kelas = normalizeClassName($('student-kelas')?.value || '');
  const jenis = String($('student-jenis')?.value || 'L').trim() || 'L';
  const agama = String($('student-agama')?.value || 'Islam').trim() || 'Islam';
  if (!nik || !nama || !kelas) return toast('NIK, nama, dan kelas wajib diisi.');
  setLoading(true,'Menyimpan data siswa...');
  try {
    await upsertStudentFromAdminForm({ nik: editNik || nik, nisn, nis, nama, kelas, jenis, agama });
    const s = findStudentByNik(editNik || nik);
    if (s) renderSingleQR($('admin-student-qr-result'), { nama:s.Nama, kelas:s.Kelas, absen:s.Absen, jk:s.Jenis||s.JK, agama:s.Agama, nik:s.NIK });
    studentFormReset();
    if ($('admin-student-class-picker')) $('admin-student-class-picker').value = kelas;
    renderAll();
    toast('Data siswa berhasil disimpan.');
  } catch(e){ toast(e.message || 'Gagal simpan siswa.'); }
  finally { setLoading(false); }
}
async function upsertStudentFromAdminForm({ nik, nisn, nis, nama, kelas, jenis, agama }){
  const kelasFix = normalizeClassName(kelas);
  const nikFix = normalizeNik(nik);
  if (!nikFix) throw new Error('NIK wajib diisi.');
  let touched = new Set();
  const existing = findStudentByNik(nikFix);
  if (existing) {
    const oldClass = existing.Kelas;
    const idx = (localDB[oldClass] || []).findIndex(s => normalizeNik(s.NIK) === nikFix);
    if (idx < 0) throw new Error('Data siswa tidak ditemukan.');
    const preferredAbsen = normalizeAbsen(existing.Absen || nextAbsenForClass(kelasFix));
    const absenTarget = oldClass === kelasFix
      ? preferredAbsen
      : ((localDB[kelasFix] || []).some(s => normalizeAbsen(s.Absen) === preferredAbsen) ? nextAbsenForClass(kelasFix) : preferredAbsen);
    const updated = normalizeStudentRow({
      ...existing,
      NIK: nikFix,
      NISN: nisn || '-',
      NIS: nis || '-',
      Nama: nama || existing.Nama,
      Kelas: kelasFix,
      Absen: absenTarget,
      Jenis: jenis || existing.Jenis,
      JK: jenis || existing.JK,
      Agama: agama || existing.Agama
    });
    localDB[oldClass].splice(idx, 1);
    touched.add(oldClass);
    localDB[kelasFix].push(updated);
    touched.add(kelasFix);
  } else {
    localDB[kelasFix].push(normalizeStudentRow({
      NIK: nikFix,
      NISN: nisn || '-',
      NIS: nis || '-',
      Nama: nama,
      Kelas: kelasFix,
      Absen: nextAbsenForClass(kelasFix),
      Jenis: jenis || 'L',
      JK: jenis || 'L',
      Agama: agama || 'Islam',
      NoHP: '-'
    }));
    touched.add(kelasFix);
  }
  touched.forEach(resequenceClassAlphabetical);
  saveCacheDB();
  for (const k of touched) await syncClassToFirestore(k);
  return findStudentByNik(nikFix);
}
function renderAdminStudentList(){
  const box = $('admin-student-list'); if (!box) return;
  const kelas = adminStudentSelectedClass();
  let arr = sortStudentsAlpha(localDB[kelas] || []);
  const q = String($('admin-student-search')?.value || '').toLowerCase().trim();
  if (q) arr = arr.filter(s => `${s.Nama} ${s.NIK} ${s.NISN} ${s.NIS}`.toLowerCase().includes(q));
  setText('admin-student-summary', `${kelas} • ${arr.length} siswa`);
  box.innerHTML = arr.map((s,idx)=>`<div class="glass p-4 rounded-[1.5rem] flex items-center justify-between gap-3"><div><div class="text-xs font-black text-white uppercase">${idx+1}. ${safeUpper(s.Nama)}</div><div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">ABSEN ${s.Absen || '-'} • NIK ${s.NIK||'-'} • NISN ${s.NISN||'-'} • NIS ${s.NIS||'-'} • ${s.Jenis||s.JK||'-'} • ${s.Agama||'-'}</div></div><button class="admin-edit-student-btn px-4 py-2 rounded-xl border border-cyan-500/30 text-cyan-300 text-[10px] font-black uppercase tracking-widest" data-nik="${s.NIK || ''}">Edit</button></div>`).join('') || '<div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Belum ada siswa di kelas ini.</div>';
  box.querySelectorAll('.admin-edit-student-btn').forEach(btn=>btn.addEventListener('click', ()=>startEditStudentFromAdmin(btn.dataset.nik)));
}
function buildStudentList(scope, query){
  query = (query || '').trim().toLowerCase();
  const list=[]; const addFromClass=(k)=> (sortStudentsAlpha(localDB[k]||[])).forEach(s=>list.push({...s}));
  if (scope==='class' && session.kelas) addFromClass(session.kelas); else DAFTAR_KELAS.forEach(addFromClass);
  const filtered = !query ? list : list.filter(s=>`${s.Nama} ${s.Absen} ${s.Kelas} ${s.NIK||''}`.toLowerCase().includes(query));
  filtered.sort((a,b)=> a.Kelas.localeCompare(b.Kelas,'id',{numeric:true}) || String(a.Nama||'').localeCompare(String(b.Nama||''), 'id', { sensitivity:'base' }));
  return filtered;
}
function renderWaliEditList(){
  const box = $('wali-edit-list'); if (!box || !(session.role==='guru' && session.isWaliKelas && session.waliKelas)) return;
  const q = String($('wali-edit-search')?.value || '').toLowerCase().trim();
  let arr = sortStudentsAlpha(localDB[session.waliKelas] || []);
  if (q) arr = arr.filter(s => `${s.Nama} ${s.NIK} ${s.NISN} ${s.NIS}`.toLowerCase().includes(q));
  box.innerHTML = arr.map((s,idx)=>`<button class="w-full text-left glass p-3 rounded-xl wali-edit-item" data-nik="${s.NIK || ''}"><div class="text-xs font-black text-white uppercase">${idx+1}. ${safeUpper(s.Nama)}</div><div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">ABSEN ${s.Absen || '-'} • NIK ${s.NIK || '-'} • NISN ${s.NISN || '-'} • NIS ${s.NIS || '-'} • ${s.Kelas}</div></button>`).join('') || '<div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Belum ada siswa.</div>';
  box.querySelectorAll('.wali-edit-item').forEach(btn => btn.addEventListener('click', ()=>fillWaliStudentEditor(btn.dataset.nik)));
}
async function saveWaliStudentEditor(){
  const nik = $('wali-edit-nik')?.value || ''; if (!nik) return toast('Pilih siswa dulu.');
  const s = findStudentByNik(nik); if (!s) return toast('Siswa tidak ditemukan.');
  await upsertStudentFromAdminForm({ nik, nisn:$('wali-edit-nisn')?.value || '-', nis:$('wali-edit-nis')?.value || '-', nama:$('wali-edit-nama')?.value || s.Nama, kelas:s.Kelas, jenis:$('wali-edit-jenis')?.value || 'L', agama:$('wali-edit-agama')?.value || 'Islam' });
  renderAll(); toast('Data siswa diperbarui.');
}
async function exportStudentExcel(){
  const zip = new JSZip();
  let count=0;
  DAFTAR_KELAS.forEach(k=>{
    const arr = sortStudentsAlpha(localDB[k] || []);
    if (!arr.length) return;
    const rows = arr.map((s,idx)=>({ No: idx+1, NIK:s.NIK||'', NISN:s.NISN||'', NIS:s.NIS||'', Nama:s.Nama||'', Kelas:s.Kelas||k, Jenis:s.Jenis||s.JK||'', Agama:s.Agama||'' }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, k.replace('-', ''));
    const out = XLSX.write(wb, { bookType:'xlsx', type:'array' });
    zip.file(`DATA_SISWA_${k}.xlsx`, out);
    count++;
  });
  if (!count) return toast('Belum ada data siswa.');
  const blob = await zip.generateAsync({ type:'blob' });
  downloadBlobFile(blob, `DATA_SISWA_PER_KELAS_${todayId().replace(/\//g,'-')}.zip`);
}

function isAdminTopRoleTab(tabId){
  return ['view-admin','view-admin-accounts','view-admin-students','view-admin-schedule','view-admin-settings'].includes(tabId);
}
function adminRoleTabToPanel(tabId){
  switch (tabId) {
    case 'view-admin-accounts': return 'admin-panel-accounts';
    case 'view-admin-students': return 'admin-panel-students';
    case 'view-admin-schedule': return 'admin-panel-schedule';
    case 'view-admin-settings': return 'admin-panel-settings';
    case 'view-admin':
    default: return 'admin-panel-overview';
  }
}
function adminPanelToRoleTab(panelId){
  switch (panelId) {
    case 'admin-panel-accounts': return 'view-admin-accounts';
    case 'admin-panel-students': return 'view-admin-students';
    case 'admin-panel-schedule': return 'view-admin-schedule';
    case 'admin-panel-settings': return 'view-admin-settings';
    case 'admin-panel-overview':
    default: return 'view-admin';
  }
}
function setAdminTab(tabId){
  activeAdminTab = tabId || 'admin-panel-overview';
  document.querySelectorAll('[data-admin-panel]').forEach(panel => panel.classList.toggle('hidden', panel.id !== activeAdminTab));
  document.querySelectorAll('[data-admin-tab-btn]').forEach(btn => btn.classList.toggle('active', btn.dataset.adminTabBtn === activeAdminTab));
  if (activeAdminTab === 'admin-panel-overview') renderAdminOverview();
}
function getAvailableRoleTabs(){
  if (!session.role) return [];
  const tabs = [];
  if (session.role === 'admin') {
    return [
      { id: 'view-admin', label: 'Admin' },
      { id: 'view-admin-accounts', label: 'Akun Guru' },
      { id: 'view-admin-students', label: 'Data Siswa' },
      { id: 'view-admin-schedule', label: 'Jadwal Piket' },
      { id: 'view-admin-settings', label: 'Pengaturan' },
      { id: 'view-piket', label: 'Piket' }
    ];
  }
  if (session.role === 'guru') {
    tabs.push({ id: 'view-profile', label: 'Profile' });
    tabs.push({ id: 'view-pelajaran', label: 'Pelajaran' });
    if (session.isWaliKelas) tabs.push({ id: 'view-wali', label: 'Wali Kelas' });
    if (session.piketToday) tabs.push({ id: 'view-piket', label: 'Piket' });
    return tabs;
  }
  if (session.role === 'orangtua') return [{ id: 'view-ortu', label: 'Orang Tua' }];
  return tabs;
}
function applyRoleTabVisibility(){
  ['view-admin','view-wali','view-sekretaris','view-piket','view-ortu','view-pelajaran','view-profile'].forEach(hide);
  if (!activeRoleTab) return;
  if (session.role === 'admin' && isAdminTopRoleTab(activeRoleTab)) {
    show('view-admin');
    setAdminTab(adminRoleTabToPanel(activeRoleTab));
    return;
  }
  show(activeRoleTab);
}
function setRoleTab(tabId){
  activeRoleTab = tabId;
  if (session.role === 'admin' && isAdminTopRoleTab(tabId)) setAdminTab(adminRoleTabToPanel(tabId));
  renderRoleTabs();
  applyRoleTabVisibility();
}
function renderAdminOverview(){
  const box = $('admin-overview-cards');
  if (!box) return;
  const totalStudents = DAFTAR_KELAS.reduce((sum, kelas) => sum + ((localDB[kelas] || []).length), 0);
  const totalTeachers = accountsDB.filter(acc => acc.role === 'guru').length;
  const totalParents = accountsDB.filter(acc => acc.role === 'orangtua').length;
  const totalAdmins = accountsDB.filter(acc => acc.role === 'admin').length;
  const today = todayId();
  const events = getDailyEventsForDate(today) || {};
  const totalDispen = Array.isArray(events.dispen) ? events.dispen.length : 0;
  const totalPulangCepat = Array.isArray(events.pulangCepat) ? events.pulangCepat.length : 0;
  const totalTerlambat = Array.isArray(events.terlambat) ? events.terlambat.length : 0;
  box.innerHTML = `
    <div class="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
      <div class="glass p-5 rounded-[2rem]"><div class="text-[10px] uppercase tracking-widest text-gray-400 font-black">Total Siswa</div><div class="text-3xl font-black text-white mt-2">${totalStudents}</div><div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-2">${DAFTAR_KELAS.length} kelas aktif</div></div>
      <div class="glass p-5 rounded-[2rem]"><div class="text-[10px] uppercase tracking-widest text-gray-400 font-black">Akun Guru</div><div class="text-3xl font-black text-white mt-2">${totalTeachers}</div><div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-2">Admin ${totalAdmins} • Orang Tua ${totalParents}</div></div>
      <div class="glass p-5 rounded-[2rem]"><div class="text-[10px] uppercase tracking-widest text-gray-400 font-black">Event Hari Ini</div><div class="text-3xl font-black text-white mt-2">${totalDispen + totalPulangCepat + totalTerlambat}</div><div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-2">Dispen ${totalDispen} • Pulang ${totalPulangCepat}</div></div>
      <div class="glass p-5 rounded-[2rem]"><div class="text-[10px] uppercase tracking-widest text-gray-400 font-black">Operasional</div><div class="text-3xl font-black text-white mt-2">Piket</div><div class="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-2">Scan dan absensi ada di tab Piket</div></div>
    </div>
    <div class="glass p-5 rounded-[2rem]">
      <div class="text-xs font-black uppercase tracking-widest text-cyan-300">Panel Admin Dirapikan</div>
      <p class="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-3">Tab atas sekarang dipisah: akun, siswa, jadwal, dan pengaturan. Tab Piket tetap dipakai untuk scan QR, manual presensi, dispen, dan pulang cepat.</p>
    </div>`;
}
function setupAdminUi(){
  const section = $('view-admin');
  if (!section || section.dataset.adminStructured === '1') return;
  const overview = section.querySelector(':scope > div.glass');
  if (!overview) return;
  overview.id = 'admin-panel-overview';
  overview.dataset.adminPanel = '1';
  overview.classList.add('space-y-6');

  const overviewTitle = overview.querySelector(':scope > h2');
  if (overviewTitle) overviewTitle.textContent = 'ADMIN';
  const overviewDesc = overview.querySelector(':scope > p');
  if (overviewDesc) overviewDesc.textContent = 'Ringkasan kontrol admin. Menu rinci dipisah ke tab atas.';

  const overviewCards = document.createElement('div');
  overviewCards.id = 'admin-overview-cards';
  overviewCards.className = 'space-y-4';

  const accountBox = overview.querySelector(':scope > div.glass');
  const bulkBox = accountBox?.nextElementSibling && accountBox.nextElementSibling.classList.contains('glass') ? accountBox.nextElementSibling : null;
  const scheduleBox = bulkBox?.nextElementSibling && bulkBox.nextElementSibling.classList.contains('glass') ? bulkBox.nextElementSibling : null;
  const settingsGrid = scheduleBox?.nextElementSibling && scheduleBox.nextElementSibling.classList.contains('grid') ? scheduleBox.nextElementSibling : null;
  const manageBox = settingsGrid?.nextElementSibling && settingsGrid.nextElementSibling.classList.contains('glass') ? settingsGrid.nextElementSibling : null;
  const adminPresensiWrap = $('wali-create-wrap');
  const waliEditor = $('wali-editor-wrap');

  const makePanel = (id) => {
    const panel = document.createElement('div');
    panel.id = id;
    panel.dataset.adminPanel = '1';
    panel.className = 'space-y-6 hidden';
    section.appendChild(panel);
    return panel;
  };
  const accountsPanel = makePanel('admin-panel-accounts');
  const studentsPanel = makePanel('admin-panel-students');
  const schedulePanel = makePanel('admin-panel-schedule');
  const settingsPanel = makePanel('admin-panel-settings');

  if (accountBox) accountsPanel.appendChild(accountBox);
  if (bulkBox) studentsPanel.appendChild(bulkBox);
  if (scheduleBox) schedulePanel.appendChild(scheduleBox);
  if (settingsGrid) settingsPanel.appendChild(settingsGrid);
  if (manageBox) settingsPanel.appendChild(manageBox);
  if (adminPresensiWrap) adminPresensiWrap.classList.add('hidden');

  const roleSel = $('acc-role');
  if (roleSel) roleSel.innerHTML = '<option value="guru">GURU</option><option value="admin">ADMIN</option><option value="orangtua">ORANG TUA</option>';
  $('acc-siswa-wrap')?.remove();
  $('admin-student-list')?.remove();
  if ($('acc-form-title')) $('acc-form-title').textContent = 'Buat Akun Guru / Orang Tua';
  const accIntro = accountBox?.querySelector('p');
  if (accIntro) accIntro.textContent = 'Kelola akun guru, admin, dan orang tua. Data siswa dipisah ke tab Siswa.';

  if (!$('student-form-title')) {
    const studentForm = document.createElement('div');
    studentForm.className = 'glass p-6 rounded-[2rem]';
    studentForm.innerHTML = `<div class="flex items-center justify-between gap-4 mb-4"><div><h3 id="student-form-title" class="text-xs font-black uppercase tracking-widest text-cyan-300">🧾 Data Siswa</h3><p class="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-2">Tambah data satuan, edit data, dan lihat siswa per kelas. Nomor absen tetap dijaga stabil.</p></div><button id="btn-student-form-reset" class="px-4 py-3 border border-gray-700 text-gray-300 rounded-2xl text-[10px] font-black uppercase tracking-widest">Reset Form</button></div><input id="student-edit-nik" type="hidden"/><div class="grid md:grid-cols-2 gap-4 mb-4"><div><label class="text-[10px] uppercase tracking-widest font-bold text-gray-400">NIK</label><input id="student-nik" type="text" class="w-full bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white mt-1" placeholder="NIK"/></div><div><label class="text-[10px] uppercase tracking-widest font-bold text-gray-400">NISN</label><input id="student-nisn" type="text" class="w-full bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white mt-1" placeholder="NISN"/></div><div><label class="text-[10px] uppercase tracking-widest font-bold text-gray-400">NIS</label><input id="student-nis" type="text" class="w-full bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white mt-1" placeholder="NIS"/></div><div><label class="text-[10px] uppercase tracking-widest font-bold text-gray-400">Nama Siswa</label><input id="student-nama" type="text" class="w-full bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white mt-1" placeholder="Nama lengkap siswa"/></div><div><label class="text-[10px] uppercase tracking-widest font-bold text-gray-400">Kelas</label><select id="student-kelas" class="w-full bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white mt-1"></select></div><div><label class="text-[10px] uppercase tracking-widest font-bold text-gray-400">Jenis</label><select id="student-jenis" class="w-full bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white mt-1"><option value="L">Laki-laki</option><option value="P">Perempuan</option></select></div><div class="md:col-span-2"><label class="text-[10px] uppercase tracking-widest font-bold text-gray-400">Agama</label><input id="student-agama" type="text" class="w-full bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white mt-1" placeholder="Islam" value="Islam"/></div></div><div class="flex flex-wrap gap-3"><button id="btn-student-save" class="px-5 py-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all">Simpan Data Siswa</button><button id="btn-student-export-excel" class="px-5 py-3 bg-violet-700 hover:bg-violet-600 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all">Export Excel per Kelas (ZIP)</button></div><div id="admin-student-qr-result" class="mt-4"></div>`;
    studentsPanel.prepend(studentForm);
  }
  if (!$('admin-student-list')) {
    const browser = document.createElement('div');
    browser.className = 'glass p-6 rounded-[2rem]';
    browser.innerHTML = `<div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4"><div><h3 class="text-xs font-black uppercase tracking-widest text-emerald-300">📚 Daftar Siswa per Kelas</h3><p id="admin-student-summary" class="text-[10px] uppercase tracking-widest text-gray-500 font-bold mt-2">-</p></div><div class="flex flex-wrap gap-3"><select id="admin-student-class-picker" class="bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white"></select><input id="admin-student-search" class="bg-gray-900 border border-gray-800 p-4 rounded-2xl outline-none text-white" placeholder="Cari nama / NIK / NISN / NIS"/></div></div><div id="admin-student-list" class="space-y-3"></div>`;
    studentsPanel.appendChild(browser);
  }

  overview.appendChild(overviewCards);
  section.dataset.adminStructured = '1';
  setAdminTab(session.role === 'admin' && isAdminTopRoleTab(activeRoleTab) ? adminRoleTabToPanel(activeRoleTab) : 'admin-panel-overview');
}
function setupWaliUi(){
  const section = $('view-wali');
  if (!section || section.dataset.waliStructured === '1') return;
  const hero = section.querySelector(':scope > div.glass');
  const editor = $('wali-editor-wrap');
  if (hero) {
    const title = hero.querySelector(':scope > h2');
    if (title) title.textContent = 'WALI KELAS';
    const desc = hero.querySelector(':scope > p');
    if (desc) desc.textContent = 'Fokus wali kelas: edit data siswa di kelas Anda, plus download laporan kelas.';
    const createGrid = hero.querySelector(':scope > div.grid.lg\\:grid-cols-2');
    if (createGrid) createGrid.remove();
    const exportBox = hero.querySelector(':scope > div.mt-6.glass');
    if (exportBox) {
      const exportTitle = exportBox.querySelector('h3');
      if (exportTitle) exportTitle.textContent = '📊 Download Laporan Kelas';
      const exportGrid = exportBox.querySelector(':scope > div.grid');
      if (exportGrid) exportGrid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
      const dailyBtn = $('btn-wali-export-daily');
      if (dailyBtn) dailyBtn.textContent = 'Download Harian';
      const recapBtn = $('btn-wali-export-alltime');
      if (recapBtn) recapBtn.textContent = 'Download Rekap';
    }
  }
  if (editor && editor.parentElement !== section) {
    editor.remove();
    editor.classList.remove('mb-6');
    editor.classList.add('mt-2');
    const heading = editor.querySelector('h3');
    if (heading) heading.textContent = '✏️ Edit Data Siswa Kelas';
    const note = editor.querySelector('p');
    if (note) note.textContent = 'Pilih siswa lalu edit data. Fitur tambah siswa dipindahkan dari halaman wali kelas.';
    if (hero) hero.insertAdjacentElement('afterend', editor); else section.prepend(editor);
  }
  section.dataset.waliStructured = '1';
}
function bindPatchedEvents(){
  $('btn-student-save')?.addEventListener('click', saveStudentForm);
  $('btn-student-form-reset')?.addEventListener('click', studentFormReset);
  $('btn-student-export-excel')?.addEventListener('click', exportStudentExcel);
  $('admin-student-class-picker')?.addEventListener('change', renderAdminStudentList);
  $('admin-student-search')?.addEventListener('input', renderAdminStudentList);
}
function startEditAccount(index){
  const acc = accountsDB[index]; if(!acc) return;
  if ($('acc-form-title')) $('acc-form-title').textContent = 'Edit Akun';
  if ($('acc-edit-index')) $('acc-edit-index').value = String(index);
  if ($('acc-name')) $('acc-name').value = acc.displayName || '';
  if ($('acc-username')) $('acc-username').value = acc.username || '';
  if ($('acc-password')) $('acc-password').value = acc.password || '';
  if ($('acc-role')) $('acc-role').value = acc.role || 'guru';
  if ($('acc-guru-nip')) $('acc-guru-nip').value = acc.nip || '';
  if ($('acc-guru-mengajar')) $('acc-guru-mengajar').value = (acc.mengajar || []).join(', ');
  if ($('acc-is-wali')) $('acc-is-wali').checked = !!acc.isWaliKelas;
  if ($('acc-wali-kelas')) $('acc-wali-kelas').value = acc.waliKelas || '';
  if ($('acc-kelas')) $('acc-kelas').value = acc.kelas || '';
  if ($('acc-absen')) $('acc-absen').value = acc.parentAbsen || '';
  if ($('acc-hp')) $('acc-hp').value = acc.parentPhone || '';
  if ($('btn-account-save')) $('btn-account-save').textContent = 'Update Akun';
  toggleAccountFieldVisibility();
  setRoleTab('view-admin-accounts');
}
function startEditStudentFromAdmin(nik){
  const s = findStudentByNik(nik); if(!s) return toast('Siswa tidak ditemukan.');
  if ($('student-form-title')) $('student-form-title').textContent = 'Edit Data Siswa';
  if ($('student-edit-nik')) $('student-edit-nik').value = s.NIK || '';
  if ($('student-nik')) $('student-nik').value = s.NIK || '';
  if ($('student-nisn')) $('student-nisn').value = s.NISN || '';
  if ($('student-nis')) $('student-nis').value = s.NIS || '';
  if ($('student-nama')) $('student-nama').value = s.Nama || '';
  if ($('student-kelas')) $('student-kelas').value = s.Kelas || adminStudentSelectedClass();
  if ($('student-jenis')) $('student-jenis').value = s.Jenis || s.JK || 'L';
  if ($('student-agama')) $('student-agama').value = s.Agama || 'Islam';
  if ($('student-nik')) $('student-nik').readOnly = true;
  setRoleTab('view-admin-students');
}
function renderAll(){
  renderLogTo($('admin-log'), collectLogs('all'));
  renderLogTo($('wali-log'), collectLogs('class'));
  renderLogTo($('sek-log'), collectLogs('class'));
  renderLogTo($('piket-log'), collectLogs('all'));
  renderManualList($('admin-manual-list'), buildStudentList('all', $('admin-manual-search')?.value));
  renderManualList($('wali-manual-list'), buildStudentList('class', $('wali-manual-search')?.value));
  renderManualList($('sek-manual-list'), buildStudentList('class', $('sek-manual-search')?.value));
  renderManualList($('piket-manual-list'), buildStudentList('all', $('piket-manual-search')?.value));
  renderOrtuDashboard();
  setModePills('.mode-pill-admin', session.mode);
  setModePills('.mode-pill-wali', session.mode);
  setModePills('.mode-pill-sekretaris', session.mode);
  setModePills('.mode-pill-piket', session.mode);
  if ((session.role === 'guru' && session.piketToday) || session.role === 'admin') { fillPiketDispenSelectors(); renderPiketDispenPending(); }
  const notifBtn = $('btn-enable-notif'); if (notifBtn) notifBtn.classList.toggle('hidden', session.role !== 'orangtua');
  if (session.role === 'admin') {
    renderAdminOverview();
    renderAccounts();
    renderAdminStudentList();
    renderPicketScheduleAdmin();
    populateStudentClassSelects();
  }
  if (session.role === 'guru') {
    renderTeacherProfile();
    renderWaliEditList();
  }
  if (teacherCanUsePelajaran()) renderPelajaranPanel();
}
window.onload = init;

 

const PATCH_ABSENSI_VERSION = '2026-04-26-production-stability';

function patchPad2(v){ return String(v).padStart(2, '0'); }

function patchNormalizeDateId(value){
  if (!value || value === '-') return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${patchPad2(value.getMonth() + 1)}-${patchPad2(value.getDate())}`;
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[3]}-${patchPad2(slash[2])}-${patchPad2(slash[1])}`;
  const dash = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dash) return `${dash[3]}-${patchPad2(dash[2])}-${patchPad2(dash[1])}`;
  return raw.replace(/\//g, '-');
}

todayId = function(){
  return patchNormalizeDateId(new Date());
};

nowTimeId = function(){
  const d = new Date();
  return `${patchPad2(d.getHours())}:${patchPad2(d.getMinutes())}`;
};

dateRangeDays = function(n){
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(patchNormalizeDateId(x));
  }
  return out;
};

dailyKeyForDate = function(tanggal){
  return `ABSEN_DAILY_EVENTS_${patchNormalizeDateId(tanggal || todayId())}`;
};

dailyKey = function(){
  return dailyKeyForDate(todayId());
};

function patchSafeFirestoreDocId(value){
  const raw = String(value || '').trim() || 'unknown';
  const noSlash = raw.replace(/\//g, '_');
  if (noSlash === '.' || noSlash === '..') return 'dot';
  if (/^__.*__$/.test(noSlash)) return noSlash.replace(/_/g, '-');
  return noSlash.slice(0, 150);
}

function patchFirestoreReady(){
  return typeof firebase !== 'undefined' && firebase && typeof firebase.firestore === 'function';
}

function patchServerTimestamp(){
  try { return firebase.firestore.FieldValue.serverTimestamp(); }
  catch { return new Date().toISOString(); }
}

function patchParseMinutes(value){
  if (!value || value === '-') return null;
  const m = String(value).trim().replace(/\./g, ':').match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function patchAttendanceRecordId(student, kelas, absen){
  const nik = normalizeNik(student?.NIK);
  return patchSafeFirestoreDocId(nik ? `NIK_${nik}` : studentKey(kelas, absen));
}

function patchAttendancePayload({ tanggal, kelas, absen, student, status, jam, note, source }){
  const dateId = patchNormalizeDateId(tanggal);
  return {
    tanggal: dateId,
    Tanggal: dateId,
    kelas: normalizeClassName(kelas),
    Kelas: normalizeClassName(kelas),
    absen: normalizeAbsen(absen),
    Absen: normalizeAbsen(absen),
    nik: normalizeNik(student?.NIK) || null,
    NIK: normalizeNik(student?.NIK) || null,
    nama: student?.Nama || '-',
    Nama: student?.Nama || '-',
    status,
    Status: status,
    jam: status === 'ALPA' ? '-' : jam,
    Jam: status === 'ALPA' ? '-' : jam,
    catatan: note?.trim() || student?.Catatan || '-',
    Catatan: note?.trim() || student?.Catatan || '-',
    source: source || 'MANUAL',
    Sumber: source || 'MANUAL',
    createdBy: session?.username || null,
    createdByName: session?.displayName || session?.username || null,
    updatedAt: patchServerTimestamp()
  };
}

function patchApplyStatusCounter(student, oldStatus, newStatus, alreadyToday){
  const counters = { HADIR: 'Hadir', IZIN: 'Izin', SAKIT: 'Sakit', ALPA: 'Alpa' };
  Object.values(counters).forEach(key => { student[key] = Number(student[key] || 0); });
  if (alreadyToday && counters[oldStatus] && oldStatus !== newStatus) {
    student[counters[oldStatus]] = Math.max(0, Number(student[counters[oldStatus]] || 0) - 1);
  }
  if (!alreadyToday || oldStatus !== newStatus) {
    if (counters[newStatus]) student[counters[newStatus]] = Number(student[counters[newStatus]] || 0) + 1;
  }
}

function patchBuildNextAttendanceStudent({ current, today, status, jam, note, daily, skey }){
  const next = normalizeStudentRow({ ...current });
  const oldStatus = next.Status || '-';
  const alreadyToday = patchNormalizeDateId(next.Tanggal) === today && oldStatus !== '-';
  const jamMinutes = patchParseMinutes(jam);
  const lateCutoff = patchParseMinutes(settings.lateCutoff || '06:30') ?? 390;
  const oldLate = !!(daily?.terlambat?.[skey] && daily.terlambat[skey] !== '-');
  const isLate = status === 'HADIR' && jamMinutes !== null && jamMinutes > lateCutoff;

  patchApplyStatusCounter(next, oldStatus, status, alreadyToday);
  next.Tanggal = today;
  next.Status = status;
  next.Jam = status === 'ALPA' ? '-' : jam;
  next.Catatan = note?.trim() || next.Catatan || '-';
  next.Terlambat = Number(next.Terlambat || 0);

  if (isLate) {
    next.JamTerlambat = jam;
    if (!oldLate) next.Terlambat += 1;
  } else {
    next.JamTerlambat = '-';
    if (oldLate) next.Terlambat = Math.max(0, next.Terlambat - 1);
  }

  return { next, alreadyToday, isLate, oldStatus };
}

async function patchWriteAttendanceAtomic({ tanggal, kelas, absen, beforeStudent, nextStudent, status, jam, note, source, allowEdit }){
  if (!patchFirestoreReady()) return { ok: true, offline: true };
  const db = firebase.firestore();
  const dateId = patchNormalizeDateId(tanggal);
  const kelasFix = normalizeClassName(kelas);
  const absenFix = normalizeAbsen(absen);
  const recordId = patchAttendanceRecordId(beforeStudent, kelasFix, absenFix);
  const recordRef = db.collection('attendance').doc(dateId).collection('records').doc(recordId);
  const studentRef = db.collection('kelas').doc(kelasFix).collection('siswa').doc(patchSafeFirestoreDocId(absenFix));
  const payload = patchAttendancePayload({ tanggal: dateId, kelas: kelasFix, absen: absenFix, student: nextStudent, status, jam, note, source });
  let duplicate = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(recordRef);
    if (snap.exists && !allowEdit) {
      duplicate = snap.data() || {};
      return;
    }
    const recordData = snap.exists ? { ...payload, editedAt: patchServerTimestamp() } : { ...payload, createdAt: patchServerTimestamp() };
    tx.set(recordRef, recordData, { merge: true });
    tx.set(studentRef, nextStudent, { merge: true });
  });

  if (duplicate) return { ok: false, duplicate: true, data: duplicate };
  return { ok: true };
}

async function patchSyncStudentToFirestore(kelas, student){
  if (!patchFirestoreReady() || !kelas || !student) return;
  const kelasFix = normalizeClassName(kelas);
  const s = normalizeStudentRow({ ...student, Kelas: kelasFix });
  await firebase.firestore()
    .collection('kelas')
    .doc(kelasFix)
    .collection('siswa')
    .doc(patchSafeFirestoreDocId(normalizeAbsen(s.Absen)))
    .set(s, { merge: true });
}

async function patchWriteDailyEventDoc(tanggal, type, skey, value){
  if (!patchFirestoreReady() || !tanggal || !type || !skey) return;
  const ref = firebase.firestore()
    .collection('dailyEvents')
    .doc(patchNormalizeDateId(tanggal))
    .collection(type)
    .doc(patchSafeFirestoreDocId(skey));

  if (type === 'terlambat') {
    if (value && value !== '-') await ref.set({ jam: value, updatedAt: patchServerTimestamp() }, { merge: true });
    else await ref.delete().catch(() => null);
    return;
  }

  if (value && typeof value === 'object') await ref.set({ ...value, updatedAt: patchServerTimestamp() }, { merge: true });
  else await ref.delete().catch(() => null);
}

async function patchSyncDailyMap(tanggal, type, map){
  const entries = Object.entries(map || {});
  if (!entries.length) return;
  const jobs = entries.map(([key, value]) => patchWriteDailyEventDoc(tanggal, type, key, value));
  await Promise.all(jobs);
}

syncTerlambatToFirestore = async function(tanggal){
  const dateId = patchNormalizeDateId(tanggal || todayId());
  const daily = getDailyEventsForDate(dateId);
  await patchSyncDailyMap(dateId, 'terlambat', daily.terlambat || {});
};

syncDispenToFirestore = async function(tanggal){
  const dateId = patchNormalizeDateId(tanggal || todayId());
  const daily = getDailyEventsForDate(dateId);
  await patchSyncDailyMap(dateId, 'dispen', daily.dispen || {});
};

syncPulangCepatToFirestore = async function(tanggal){
  const dateId = patchNormalizeDateId(tanggal || todayId());
  const daily = getDailyEventsForDate(dateId);
  await patchSyncDailyMap(dateId, 'pulangCepat', daily.pulangCepat || {});
};

syncClassToFirestore = async function(kelas){
  const kelasFix = normalizeClassName(kelas);
  if (!kelasFix) return;
  resequenceClassAlphabetical(kelasFix);
  saveCacheDB();

  try {
    if (!patchFirestoreReady()) return;
    const db = firebase.firestore();
    const kelasRef = db.collection('kelas').doc(kelasFix).collection('siswa');
    const snapshot = await kelasRef.get();
    const students = (localDB[kelasFix] || []).map(s => normalizeStudentRow({ ...s, Kelas: kelasFix }));
    const desiredIds = new Set(students.map(s => patchSafeFirestoreDocId(normalizeAbsen(s.Absen))));
    let batch = db.batch();
    let count = 0;

    async function commitIfNeeded(force = false){
      if (count >= 400 || (force && count > 0)) {
        await batch.commit();
        batch = db.batch();
        count = 0;
      }
    }

    for (const doc of snapshot.docs) {
      if (!desiredIds.has(doc.id)) {
        batch.delete(doc.ref);
        count++;
        await commitIfNeeded(false);
      }
    }

    for (const s of students) {
      batch.set(kelasRef.doc(patchSafeFirestoreDocId(normalizeAbsen(s.Absen))), s, { merge: true });
      count++;
      await commitIfNeeded(false);
    }

    await commitIfNeeded(true);
    if (typeof flushAccountRepairV5 === 'function') await flushAccountRepairV5();
  } catch (e) {
    console.error('Gagal sync kelas ke Firestore:', e);
    throw e;
  }
};

markAttendance = async function({ kelas, absen, status, jamOverride = null, note = null, source = 'MANUAL' }){
  ensureBuckets();
  const today = todayId();
  const kelasFix = normalizeClassName(kelas);
  const absenFix = normalizeAbsen(absen);
  const statusFix = String(status || 'HADIR').trim().toUpperCase();
  const allowed = ['HADIR', 'IZIN', 'SAKIT', 'ALPA'];
  if (!allowed.includes(statusFix)) return { ok: false, msg: `Status ${statusFix} tidak valid.` };
  if (!DAFTAR_KELAS.includes(kelasFix)) return { ok: false, msg: `Kelas ${kelas || '-'} tidak valid.` };

  if (lockedClassRequired() && kelasFix !== session.kelas) {
    return { ok: false, msg: `Kelas tidak sesuai. Wajib ${session.kelas}.` };
  }

  const idx = (localDB[kelasFix] || []).findIndex(s => normalizeAbsen(s.Absen) === absenFix);
  if (idx === -1) return { ok: false, msg: `Data tidak ada di kelas ${kelasFix}.` };

  const current = normalizeStudentRow(localDB[kelasFix][idx]);
  const oldStatus = current.Status || '-';
  const alreadyToday = patchNormalizeDateId(current.Tanggal) === today && oldStatus !== '-';
  const isScan = String(source || '').toUpperCase().includes('SCAN');
  const jam = statusFix === 'ALPA' ? '-' : String(jamOverride || nowTimeId()).replace(/\./g, ':');
  const jamMinutes = patchParseMinutes(jam);

  if (statusFix === 'HADIR') {
    if (jamMinutes === null) return { ok: false, msg: `Format jam tidak valid: ${jam}` };
    if (jamMinutes < 5 * 60) return { ok: false, msg: `Presensi belum dimulai! Minimal jam 05:00. (Sekarang ${jam})` };
  }

  if (isScan && alreadyToday) {
    return { ok: false, msg: `Sudah absen hari ini: ${oldStatus} • ${current.Jam || '-'}` };
  }

  const daily = getDailyEventsForDate(today);
  if (!daily.terlambat) daily.terlambat = {};
  const skey = studentKey(kelasFix, absenFix);
  const built = patchBuildNextAttendanceStudent({ current, today, status: statusFix, jam, note, daily, skey });
  const nextStudent = built.next;

  let writeResult;
  try {
    writeResult = await patchWriteAttendanceAtomic({
      tanggal: today,
      kelas: kelasFix,
      absen: absenFix,
      beforeStudent: current,
      nextStudent,
      status: statusFix,
      jam,
      note,
      source,
      allowEdit: !isScan
    });
  } catch (e) {
    console.error('Gagal menulis absensi:', e);
    return { ok: false, msg: 'Gagal simpan ke server. Coba ulangi atau cek koneksi/rules Firestore.' };
  }

  if (!writeResult.ok && writeResult.duplicate) {
    const prev = writeResult.data || {};
    return { ok: false, msg: `Sudah absen di server: ${prev.Status || prev.status || '-'} • ${prev.Jam || prev.jam || '-'}` };
  }

  daily.terlambat[skey] = built.isLate ? jam : '-';
  localDB[kelasFix][idx] = nextStudent;
  saveDailyEventsForDate(today, daily);
  saveCacheDB();

  patchWriteDailyEventDoc(today, 'terlambat', skey, daily.terlambat[skey]).catch(console.error);
  checkParentStatusChange().catch(console.error);

  return { ok: true, student: nextStudent, edited: built.alreadyToday };
};

upsertDispen = function({ kelas, absen, waktu, outTime, backTime, alasan }){
  const kelasFix = normalizeClassName(kelas);
  const absenFix = normalizeAbsen(absen);
  const today = todayId();
  const daily = getDailyEventsForDate(today);
  if (!daily.dispen) daily.dispen = {};
  const skey = studentKey(kelasFix, absenFix);
  const prev = daily.dispen[skey] || {};
  daily.dispen[skey] = {
    out: waktu || outTime || prev.out || '-',
    back: backTime || prev.back || '-',
    alasan: alasan || prev.alasan || '-',
    _counted: !!prev._counted
  };

  const idx = (localDB[kelasFix] || []).findIndex(s => normalizeAbsen(s.Absen) === absenFix);
  if (idx !== -1) {
    const s = normalizeStudentRow(localDB[kelasFix][idx]);
    if (!daily.dispen[skey]._counted) {
      s.Dispen = Number(s.Dispen || 0) + 1;
      daily.dispen[skey]._counted = true;
    }
    s.Catatan = alasan || s.Catatan || '-';
    localDB[kelasFix][idx] = normalizeStudentRow(s);
    patchSyncStudentToFirestore(kelasFix, localDB[kelasFix][idx]).catch(console.error);
  }

  saveDailyEventsForDate(today, daily);
  saveCacheDB();
  patchWriteDailyEventDoc(today, 'dispen', skey, daily.dispen[skey]).catch(console.error);
  setTimeout(() => checkParentStatusChange(), 1000);
};

markBackDispen = function({ kelas, absen, backTime }){
  const kelasFix = normalizeClassName(kelas);
  const absenFix = normalizeAbsen(absen);
  const today = todayId();
  const daily = getDailyEventsForDate(today);
  const skey = studentKey(kelasFix, absenFix);
  if (!daily.dispen?.[skey]) return false;
  daily.dispen[skey].back = backTime || nowTimeId();
  saveDailyEventsForDate(today, daily);
  patchWriteDailyEventDoc(today, 'dispen', skey, daily.dispen[skey]).catch(console.error);
  setTimeout(() => checkParentStatusChange(), 1000);
  return true;
};

setPulangCepat = function({ kelas, absen, waktu, time, alasan }){
  const kelasFix = normalizeClassName(kelas);
  const absenFix = normalizeAbsen(absen);
  const today = todayId();
  const daily = getDailyEventsForDate(today);
  if (!daily.pulangCepat) daily.pulangCepat = {};
  const skey = studentKey(kelasFix, absenFix);
  const prev = daily.pulangCepat[skey] || {};
  daily.pulangCepat[skey] = {
    time: waktu || time || prev.time || '-',
    alasan: alasan || prev.alasan || '-',
    _counted: !!prev._counted
  };

  const idx = (localDB[kelasFix] || []).findIndex(s => normalizeAbsen(s.Absen) === absenFix);
  if (idx !== -1) {
    const s = normalizeStudentRow(localDB[kelasFix][idx]);
    if (!daily.pulangCepat[skey]._counted) {
      s.PulangCepat = Number(s.PulangCepat || 0) + 1;
      daily.pulangCepat[skey]._counted = true;
    }
    s.Catatan = alasan || s.Catatan || '-';
    localDB[kelasFix][idx] = normalizeStudentRow(s);
    patchSyncStudentToFirestore(kelasFix, localDB[kelasFix][idx]).catch(console.error);
  }

  saveDailyEventsForDate(today, daily);
  saveCacheDB();
  patchWriteDailyEventDoc(today, 'pulangCepat', skey, daily.pulangCepat[skey]).catch(console.error);
  setTimeout(() => checkParentStatusChange(), 1000);
};

function patchParseLooseStudentRow(line){
  const raw = String(line || '').trim();
  if (!raw) return null;
  const delimiters = [';', '\t', '|', ','];
  for (const delimiter of delimiters) {
    const parts = raw.split(delimiter === '\t' ? /\t/ : delimiter).map(x => x.trim()).filter(Boolean);
    if (parts.length >= 7) {
      return {
        nik: parts[0],
        nisn: parts[1],
        nis: parts[2],
        nama: parts.slice(3, parts.length - 3).join(' ').trim() || parts[3],
        kelas: parts[parts.length - 3],
        jenis: parts[parts.length - 2],
        agama: parts[parts.length - 1]
      };
    }
  }
  const legacy = raw.match(/^(.+?)-(.+?)-(.+?)-(.+?)-(XII-?\d+|XI-?\d+|X-?\d+)-(L|P|LAKI-LAKI|PEREMPUAN)-(.+)$/i);
  if (legacy) {
    return {
      nik: legacy[1].trim(),
      nisn: legacy[2].trim(),
      nis: legacy[3].trim(),
      nama: legacy[4].trim(),
      kelas: legacy[5].trim(),
      jenis: legacy[6].trim(),
      agama: legacy[7].trim()
    };
  }
  return null;
}

parseBulkStudentText = function(text){
  const rows = [];
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  lines.forEach((line, idx) => {
    if (idx === 0 && /^nik[;,\t|,-]/i.test(line)) return;
    const parsed = patchParseLooseStudentRow(line);
    if (!parsed) throw new Error(`Baris ${idx + 1} tidak valid. Pakai format: nik;nisn;nis;nama;kelas;jenis;agama`);
    const kelas = normalizeClassName(parsed.kelas);
    if (!DAFTAR_KELAS.includes(kelas)) throw new Error(`Baris ${idx + 1}: kelas ${parsed.kelas} tidak dikenal.`);
    rows.push({ ...parsed, kelas });
  });
  return rows;
};

function patchParseWaliBulkLine(kelas, line){
  const raw = String(line || '').trim();
  if (!raw) return null;
  if (raw.includes(';')) {
    const parts = raw.split(';').map(x => x.trim());
    if (parts.length >= 5) {
      const [nama, absen, jk, agama, phone, nik = '', nisn = '-', nis = '-'] = parts;
      return { nama, absen: normalizeAbsen(absen), jk, agama, phone, nik, nisn, nis };
    }
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 5) return null;
  const phone = parts.pop();
  const agama = parts.pop();
  const jk = parts.pop();
  const absen = normalizeAbsen(parts.pop());
  const nama = parts.join(' ');
  return { nama, absen, jk, agama, phone, nik: '', nisn: '-', nis: '-' };
}

bulkProcessAndZipForClass = async function(kelas, textareaValue){
  const kelasFix = normalizeClassName(kelas);
  const input = String(textareaValue || '').trim();
  if (!input) return toast('Bulk kosong.');
  ensureBuckets();

  const lines = input.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const touched = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const parsed = patchParseWaliBulkLine(kelasFix, lines[i]);
    if (!parsed || !parsed.nama || !parsed.absen || Number.isNaN(Number(parsed.absen))) {
      errors.push(`Baris ${i + 1} tidak valid.`);
      continue;
    }
    const idx = (localDB[kelasFix] || []).findIndex(s => normalizeAbsen(s.Absen) === normalizeAbsen(parsed.absen));
    const next = normalizeStudentRow({
      NIK: normalizeNik(parsed.nik),
      NISN: parsed.nisn || '-',
      NIS: parsed.nis || '-',
      Nama: parsed.nama,
      Kelas: kelasFix,
      Absen: parsed.absen,
      JK: parsed.jk,
      Jenis: parsed.jk,
      Agama: parsed.agama,
      NoHP: normalizePhone(parsed.phone) || '-'
    });
    if (idx >= 0) localDB[kelasFix][idx] = normalizeStudentRow({ ...localDB[kelasFix][idx], ...next });
    else localDB[kelasFix].push(next);
    touched.push(next);
  }

  if (!touched.length) {
    if (errors.length) console.warn(errors);
    return toast('Tidak ada baris valid untuk diproses.');
  }

  try {
    setLoading(true, 'Menyimpan data dan membuat QR...');
    saveCacheDB();
    await syncClassToFirestore(kelasFix);
    const students = touched.map(s => findStudentByKelasAbsen(kelasFix, s.Absen) || s);
    const blob = await buildQrZipForStudents(students, `QR_BULK_${kelasFix}_${todayId()}`);
    if (blob) downloadBlobFile(blob, `QR_BULK_${kelasFix}_${todayId()}.zip`);
    if (errors.length) console.warn(errors);
    renderAll();
    toast(errors.length ? `Selesai, tapi ${errors.length} baris dilewati. Cek console.` : 'Selesai. ZIP terunduh.');
  } catch (e) {
    console.error(e);
    toast('Bulk gagal. Cek console.');
  } finally {
    setLoading(false);
  }
};

studentAlreadyScannedTodayV5 = function(kelas, absen){
  const student = findStudentByKelasAbsen(normalizeClassName(kelas), absen);
  return !!(student && patchNormalizeDateId(student.Tanggal) === todayId() && student.Status && student.Status !== '-');
};

onScan = async function(prefix, text){
  if (!scanMemory[prefix]) scanMemory[prefix] = { text: '', at: 0 };
  const now = Date.now();
  if (text === scanMemory[prefix].text && (now - scanMemory[prefix].at) < SCAN_COOLDOWN_MS) return;
  scanMemory[prefix] = { text, at: now };

  const payload = parsePayload(text);
  if (!payload) return showFeedback(prefix, '❌', 'QR INVALID', 'FORMAT TIDAK SESUAI', 'bg-red-700');

  const kelasFix = normalizeClassName(payload.kelas);
  const absenFix = normalizeAbsen(payload.absen);
  const nama = payload.nama || '-';

  if (prefix === 'pelajaran') {
    const active = currentOpenLessonSessionV4();
    if (!active) return showFeedback(prefix, '❌', safeUpper(nama), 'MULAI ABSENSI KELAS DULU', 'bg-red-700');
    if (active.kelas !== kelasFix) return showFeedback(prefix, '❌', safeUpper(nama), `KELAS AKTIF ${active.kelas}, QR ${kelasFix}`, 'bg-red-700');
    const r = await markLessonAttendance({ kelas: kelasFix, absen: absenFix, status: 'HADIR', source: 'SCAN QR' });
    if (!r.ok) return showFeedback(prefix, '❌', safeUpper(nama), r.msg, 'bg-red-700');
    showFeedback(prefix, '✅', safeUpper(r.student.Nama), `PELAJARAN HADIR • ${kelasFix} • ABSEN ${normalizeAbsen(r.student.Absen)}`, 'bg-green-700');
    renderAll();
    return;
  }

  if (lockedClassRequired() && kelasFix !== session.kelas) {
    return showFeedback(prefix, '❌', safeUpper(nama), `KELAS TIDAK SESUAI (WAJIB ${session.kelas})`, 'bg-red-700');
  }

  if (studentAlreadyScannedTodayV5(kelasFix, absenFix)) {
    const student = findStudentByKelasAbsen(kelasFix, absenFix);
    const info = student ? `SUDAH ${student.Status || 'ABSEN'} • ${student.Jam || '-'}` : 'SUDAH ABSEN HARI INI';
    return showFeedback(prefix, '⚠️', safeUpper(student?.Nama || nama), info, 'bg-amber-700');
  }

  const status = session.mode || 'HADIR';
  const r = await markAttendance({ kelas: kelasFix, absen: absenFix, status, source: 'SCAN QR' });
  if (!r.ok) return showFeedback(prefix, '❌', safeUpper(nama), r.msg, 'bg-red-700');

  const icon = status === 'HADIR' ? '✅' : status === 'IZIN' ? '📝' : status === 'SAKIT' ? '🤒' : '❌';
  showFeedback(prefix, icon, safeUpper(r.student.Nama), `PRESENSI ${status} • ${kelasFix} • ABSEN ${normalizeAbsen(r.student.Absen)}`, 'bg-green-700');
  renderAll();
};

function patchMigrateLegacyDailyEventsStorage(){
  try {
    const moves = [];
    const prefix = 'ABSEN_DAILY_EVENTS_';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const oldDate = key.slice(prefix.length);
      const newDate = patchNormalizeDateId(oldDate);
      const newKey = `${prefix}${newDate}`;
      if (newKey !== key) moves.push([key, newKey]);
    }
    moves.forEach(([oldKey, newKey]) => {
      if (!localStorage.getItem(newKey)) localStorage.setItem(newKey, localStorage.getItem(oldKey));
    });
  } catch (e) {
    console.warn('Migrasi daily events lama dilewati:', e);
  }
}


window.onload = init;
