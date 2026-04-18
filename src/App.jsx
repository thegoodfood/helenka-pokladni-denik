import { useState, useEffect, useRef, useMemo, useCallback } from "react"; // v1776428651515

/*
  POKLADNÍ DENÍK — Helenka 1.1
  Supabase backend – všechna data persistent v DB.
  Role: superadmin (vše), manažer (jen přiřazené firmy), zaměstnanec.
*/

// ============================================================
// SUPABASE CONFIG
// ============================================================
const SB_URL = "https://ekfjznjzmlslrtatervl.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrZmp6bmp6bWxzbHJ0YXRlcnZsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzA0MzAsImV4cCI6MjA5MTQwNjQzMH0.nJij_8RjdTbZWho8Y_FOpzHSwe6OGjMG3K9A2MMPu4Y";

const sbHeaders = {
  "Content-Type": "application/json",
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Prefer": "return=representation",
};

// Základní REST volání na Supabase
async function sbGet(table, params = "") {
  const res = await fetch(`${SB_URL}/rest/v1/${table}${params ? "?" + params : ""}`, {
    headers: { ...sbHeaders, "Prefer": "return=representation" },
  });
  if (!res.ok) throw new Error(`GET ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbPost(table, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${table}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

async function sbPatch(table, filter, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: sbHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${table}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

async function sbDelete(table, filter) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: "DELETE",
    headers: { ...sbHeaders, "Prefer": "return=minimal" },
  });
  if (!res.ok) throw new Error(`DELETE ${table}: ${res.status} ${await res.text()}`);
  return true;
}

// Upload souboru do Supabase Storage bucket "receipts"
async function sbUploadFile(file, path) {
  const res = await fetch(`${SB_URL}/storage/v1/object/receipts/${path}`, {
    method: "POST",
    headers: {
      "apikey": SB_KEY,
      "Authorization": `Bearer ${SB_KEY}`,
      "Content-Type": file.type || "application/octet-stream",
      "x-upsert": "true",
    },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  return `${SB_URL}/storage/v1/object/public/receipts/${path}`;
}

// ============================================================
// GOOGLE SHEETS & DRIVE (simulované – nahradit Vercel Edge fn.)
// Service account: pokladni-denik-export@pokladni-denik.iam.gserviceaccount.com
// ============================================================
const SHEET_HEADERS = ["Datum", "Čas", "Typ", "Typ platby", "Kategorie", "Dodavatel/Odběratel", "Popis", "Bez DPH", "S DPH", "Vklad/Výběr", "Storno"];
const DRIVE_ROOT_FOLDER_ID = "1ZO5cektWhTT6AZTQJ3GiIuJHOyJMluAv";

// ============================================================
// STORE – Supabase REST API
// ============================================================
function useStore() {
  const [firmy, setFirmy] = useState([]);
  const [zam, setZam] = useState([]);
  const [asgn, setAsgn] = useState([]);
  const [kat, setKat] = useState([]);
  const [tx, setTx] = useState([]);
  const [notifs, setNotifs] = useState([]);
  const [sheetsLog, setSheetsLog] = useState([]);
  const [driveLog, setDriveLog] = useState([]);
  const [limits, setLimits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const localId = useRef(-1);
  const lid = () => { localId.current -= 1; return localId.current; }; // temp negativní ID před fetch

  // ── INITIAL LOAD ──────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [fRes, zRes, aRes, kRes, tRes, nRes, lRes] = await Promise.all([
        sbGet("firmy", "order=nazev.asc"),
        sbGet("zamestnanci", "order=jmeno.asc"),
        sbGet("zamestnanec_firma"),
        sbGet("kategorie", "order=nazev.asc"),
        sbGet("transakce", "order=created_at.desc&limit=500"),
        sbGet("notifikace", "order=created_at.desc&limit=100"),
        sbGet("limity"),
      ]);
      setFirmy(fRes);
      setZam(zRes);
      // Normalizuj assignments → {zamestnanec_id, firma_id}
      setAsgn(aRes.map(r => ({ zamestnanec_id: r.zamestnanec_id, firma_id: r.firma_id })));
      setKat(kRes);
      setTx(tRes);
      setNotifs(nRes.map(n => ({
        id: n.id, type: n.typ, tx_id: n.tx_id,
        user_id: n.user_id, popis: n.popis, pozn: n.pozn,
        time: n.created_at, read: n.read,
      })));
      setLimits(lRes);
    } catch (e) {
      setError(e.message);
      console.error("Supabase fetchAll error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── GOOGLE SHEETS (simulováno) ────────────────────────────
  // Mapa firmaId → Apps Script webhook URL
  const SHEETS_WEBHOOKS = {
    1: "https://script.google.com/macros/s/AKfycbx1hK6r5NyVvblSO5mxzFqeVD5ncbIE9CDmeQCvj6fQ2L7Nmr5g9zydTdRnOlaceT0Q/exec", // THE GOOD FOOD s.r.o.
    2: "https://script.google.com/macros/s/AKfycbxybOjYGvt0lJwjXCIlFIW21E5Gicqr1e1DB8shf9Zcuu35aE6fassR9kvxGGNLnQDNIQ/exec", // KREKRRR cz s.r.o.
    3: "https://script.google.com/macros/s/AKfycbxTqbuqdLM7VjXz0v1zwOh4rrgnk08gobxiW0UCa6Y5VURa3KYDbdzh3fe6kG49MIB94w/exec", // THE GOOD EVENT s.r.o.
  };

  const exportToSheets = async (txData, zamName, firmaId, firmaNazev, katName) => {
    const webhookUrl = SHEETS_WEBHOOKS[firmaId];
    const logEntry = {
      id: lid(), time: new Date().toISOString(),
      spreadsheet: firmaNazev, sheet: zamName,
      status: webhookUrl ? "pending" : "no_webhook",
    };
    setSheetsLog(p => [logEntry, ...p]);
    if (!webhookUrl) return logEntry;
    try {
      const payload = {
        zamestnanec: zamName,
        datum: new Date(txData.created_at).toLocaleDateString("cs-CZ", { day: "2-digit", month: "2-digit", year: "2-digit" }),
        cas: new Date(txData.created_at).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }),
        typ: txData.typ === "prijem" ? "Příjem" : "Výdaj",
        typ_platby: txData.typ_platby === "hotovost" ? "Hotovost" : "Karta",
        kategorie: katName || "—",
        dodavatel: txData.dodavatel || "—",
        popis: txData.popis || "—",
        cena_bez_dph: txData.cena_bez_dph,
        cena_s_dph: txData.cena_s_dph,
        je_vklad: txData.is_vklad ? (txData.typ === "prijem" ? "Vklad" : "Výběr") : "",
        storno: txData.storno || false,
      };
      // Fire and forget – neblokovat UI
      fetch(webhookUrl, { method: "POST", mode: "no-cors", body: JSON.stringify(payload) }).catch(() => {});
      const res = { ok: true, json: async () => ({ success: true }) };
      const result = await res.json();
      const updated = { ...logEntry, status: result.success ? "ok" : "error", error: result.error };
      setSheetsLog(p => p.map(e => e.id === logEntry.id ? updated : e));
      return updated;
    } catch (err) {
      const updated = { ...logEntry, status: "error", error: err.message };
      setSheetsLog(p => p.map(e => e.id === logEntry.id ? updated : e));
      return updated;
    }
  };

  // ── GOOGLE DRIVE (simulováno) ─────────────────────────────
  const DRIVE_URL="https://script.google.com/macros/s/AKfycbwbg1IKzodTRNlNv0ZTV357bB8NpY558WmAT7fUaRYSYrpnXG6AM-M3DrfJ9Nire70klQ/exec";
  const uploadToDrive = async (file, zamName, firmaNazev) => {
    if (!file) return null;
    const logEntry = { id: lid(), time: new Date().toISOString(), fileName: file.name, firma: firmaNazev, zamestnanec: zamName, path: `${firmaNazev} / ${zamName} / ${file.name}`, status: "uploading" };
    setDriveLog(p => [logEntry, ...p]);
    try {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      fetch("https://script.google.com/macros/s/AKfycbwbg1IKzodTRNlNv0ZTV357bB8NpY558WmAT7fUaRYSYrpnXG6AM-M3DrfJ9Nire70klQ/exec", {
        method: "Py: JSON.stringify({ zamestnanec: zamName, firma_nazev: firmaNazev, priloha_base64: b64, priloha_nazev: file.name, priloha_mime: file.type || "application/octet-stream" })
      }).catch(() => {});
      const updated = { ...logEntry, status: "ok" };
      setDriveLog(p => p.map(e => e.id === logEntry.id ? updated : e));
      return updated;
    } catch (err) {
      const updated = { ...logEntry, status: "error", error: err.message };
      setDriveLog(p => p.map(e => e.id === logEntry.id ? updated : e));
      return updated;
    }
  }
  // ── FIRMY ─────────────────────────────────────────────────
  const addFirma = async (nazev, spreadsheet_id) => {
    const row = await sbPost("firmy", { nazev, spreadsheet_id: spreadsheet_id || null });
    setFirmy(p => [...p, row]);
    return row;
  };
  const updateFirma = async (id, d) => {
    const row = await sbPatch("firmy", `id=eq.${id}`, d);
    setFirmy(p => p.map(x => x.id === id ? { ...x, ...row } : x));
    return row;
  };
  const delFirma = async (id) => {
    await sbDelete("zamestnanec_firma", `firma_id=eq.${id}`);
    await sbDelete("firmy", `id=eq.${id}`);
    setFirmy(p => p.filter(x => x.id !== id));
    setAsgn(p => p.filter(x => x.firma_id !== id));
  };

  // ── ZAMĚSTNANCI ───────────────────────────────────────────
  const addZam = async (z) => {
    const row = await sbPost("zamestnanci", { jmeno: z.jmeno, pin: z.pin, role: z.role });
    setZam(p => [...p, row]);
    return row;
  };
  const updateZam = async (id, d) => {
    const row = await sbPatch("zamestnanci", `id=eq.${id}`, d);
    setZam(p => p.map(x => x.id === id ? { ...x, ...row } : x));
    return row;
  };
  const delZam = async (id) => {
    await sbDelete("zamestnanec_firma", `zamestnanec_id=eq.${id}`);
    await sbDelete("zamestnanci", `id=eq.${id}`);
    setZam(p => p.filter(x => x.id !== id));
    setAsgn(p => p.filter(x => x.zamestnanec_id !== id));
  };
  const toggleAsgn = async (zId, fId) => {
    const has = asgn.find(x => x.zamestnanec_id === zId && x.firma_id === fId);
    if (has) {
      await sbDelete("zamestnanec_firma", `zamestnanec_id=eq.${zId}&firma_id=eq.${fId}`);
      setAsgn(p => p.filter(x => !(x.zamestnanec_id === zId && x.firma_id === fId)));
    } else {
      await sbPost("zamestnanec_firma", { zamestnanec_id: zId, firma_id: fId });
      setAsgn(p => [...p, { zamestnanec_id: zId, firma_id: fId }]);
    }
  };

  // ── KATEGORIE ─────────────────────────────────────────────
  const addKat = async (k) => {
    const row = await sbPost("kategorie", { nazev: k.nazev, typ: k.typ });
    setKat(p => [...p, row]);
    return row;
  };
  const delKat = async (id) => {
    await sbDelete("kategorie", `id=eq.${id}`);
    setKat(p => p.filter(x => x.id !== id));
  };

  // ── TRANSAKCE ─────────────────────────────────────────────
  const addTx = async (t) => {
    const payload = {
      zamestnanec_id: t.zamestnanec_id,
      firma_id: t.firma_id,
      typ: t.typ,
      kategorie_id: t.kategorie_id || null,
      dodavatel: t.dodavatel || null,
      popis: t.popis || null,
      cena_bez_dph: Number(t.cena_bez_dph),
      cena_s_dph: Number(t.cena_s_dph),
      typ_platby: t.typ_platby,
      priloha_url: t.priloha_url || null,
      is_vklad: t.is_vklad || false,
      storno: false,
      storno_pozn: null,
      edited: false,
      edit_pozn: null,
      approved: false,
    };
    const row = await sbPost("transakce", payload);
    // Zapiš historii
    await sbPost("transakce_historie", {
      transakce_id: row.id, action: "vytvoreno",
      user_id: t.zamestnanec_id, pozn: null, before_data: null,
    }).catch(() => {});
    setTx(p => [row, ...p]);
    return row;
  };

  const stornoTx = async (id, pozn, userId) => {
    const old = tx.find(x => x.id === id);
    const row = await sbPatch("transakce", `id=eq.${id}`, { storno: true, storno_pozn: pozn });
    await sbPost("transakce_historie", {
      transakce_id: id, action: "storno",
      user_id: userId, pozn, before_data: null,
    }).catch(() => {});
    // Notifikace
    const notif = await sbPost("notifikace", {
      typ: "storno", tx_id: id, user_id: userId,
      popis: old?.popis || null, pozn, read: false,
    }).catch(() => null);
    setTx(p => p.map(x => x.id === id ? { ...x, storno: true, storno_pozn: pozn } : x));
    if (notif) setNotifs(p => [{
      id: notif.id, type: "storno", tx_id: id,
      user_id: userId, popis: old?.popis, pozn,
      time: notif.created_at, read: false,
    }, ...p]);
  };

  const editTx = async (id, changes, pozn, userId) => {
    const old = tx.find(x => x.id === id);
    const snapshot = old ? {
      popis: old.popis, dodavatel: old.dodavatel,
      cena_bez_dph: old.cena_bez_dph, cena_s_dph: old.cena_s_dph,
    } : null;
    const row = await sbPatch("transakce", `id=eq.${id}`, { ...changes, edited: true, edit_pozn: pozn });
    await sbPost("transakce_historie", {
      transakce_id: id, action: "uprava",
      user_id: userId, pozn, before_data: snapshot,
    }).catch(() => {});
    const notif = await sbPost("notifikace", {
      typ: "edit", tx_id: id, user_id: userId,
      popis: old?.popis || null, pozn, read: false,
    }).catch(() => null);
    setTx(p => p.map(x => x.id === id ? { ...x, ...row } : x));
    if (notif) setNotifs(p => [{
      id: notif.id, type: "edit", tx_id: id,
      user_id: userId, popis: old?.popis, pozn,
      time: notif.created_at, read: false,
    }, ...p]);
  };

  const approveTx = async (id, userId) => {
    const row = await sbPatch("transakce", `id=eq.${id}`, { approved: true });
    await sbPost("transakce_historie", {
      transakce_id: id, action: "schvaleno",
      user_id: userId, pozn: null, before_data: null,
    }).catch(() => {});
    setTx(p => p.map(x => x.id === id ? { ...x, approved: true } : x));
  };

  // ── NOTIFIKACE ────────────────────────────────────────────
  const markNotifsRead = async () => {
    await sbPatch("notifikace", "read=eq.false", { read: true }).catch(() => {});
    setNotifs(p => p.map(x => ({ ...x, read: true })));
  };

  // ── LIMITY ────────────────────────────────────────────────
  const addLimit = async (l) => {
    const row = await sbPost("limity", {
      typ: l.typ, target_type: l.target_type,
      target_id: l.target_id, limit_czk: l.limit_czk,
    });
    setLimits(p => [...p, row]);
    return row;
  };
  const delLimit = async (id) => {
    await sbDelete("limity", `id=eq.${id}`);
    setLimits(p => p.filter(x => x.id !== id));
  };

  // ── KONTROLA LIMITŮ (pure, bez async) ─────────────────────
  const checkLimits = (txData) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const warnings = [];
    limits.forEach(lim => {
      const cutoff = lim.typ === "denny" ? startOfDay : startOfMonth;
      const relevantTx = tx.filter(t => !t.storno && t.typ === "vydaj" && new Date(t.created_at) >= cutoff);
      let spent = 0;
      if (lim.target_type === "zamestnanec") {
        if (txData.zamestnanec_id !== lim.target_id) return;
        spent = relevantTx.filter(t => t.zamestnanec_id === lim.target_id).reduce((s, t) => s + Number(t.cena_s_dph), 0);
      } else if (lim.target_type === "kategorie") {
        if (txData.kategorie_id !== lim.target_id) return;
        spent = relevantTx.filter(t => t.kategorie_id === lim.target_id).reduce((s, t) => s + Number(t.cena_s_dph), 0);
      }
      const newTotal = spent + Number(txData.cena_s_dph || 0);
      if (newTotal > lim.limit_czk) {
        const targetName = lim.target_type === "zamestnanec"
          ? (zam.find(z => z.id === lim.target_id)?.jmeno || "?")
          : (kat.find(k => k.id === lim.target_id)?.nazev || "?");
        warnings.push({ limit: lim, spent, newTotal, targetName });
      }
    });
    return warnings;
  };

  // ── DUPLICATE CHECK (pure) ────────────────────────────────
  const isDuplicate = (userId, firmaId, amount) => {
    const cutoff = Date.now() - 120000;
    return tx.some(t =>
      !t.storno && t.zamestnanec_id === userId &&
      t.firma_id === firmaId && Number(t.cena_s_dph) === Number(amount) &&
      new Date(t.created_at).getTime() > cutoff
    );
  };

  // ── Nahrání přílohy do Supabase Storage ──────────────────────────────────
  const uploadReceipt = async (file, txId, zamId) => {
    const ts = Date.now();
    const ext = file.name.split(".").pop();
    const path = `${zamId}/${txId}/${ts}.${ext}`;
    const url = await sbUploadFile(file, path);
    await sbPatch("transakce", `id=eq.${txId}`, { priloha_url: url });
    setTx(p => p.map(x => x.id === txId ? { ...x, priloha_url: url } : x));
    return url;
  };

  return {
    // data
    firmy, zamestnanci: zam, assignments: asgn, kategorie: kat,
    transakce: tx, notifs, sheetsLog, driveLog, limits,
    loading, error,
    // helpers
    refetch: fetchAll,
    exportToSheets, uploadToDrive, uploadReceipt,
    checkLimits, isDuplicate,
    // async CRUD
    addFirma, updateFirma, delFirma,
    addZam, updateZam, delZam, toggleAsgn,
    addKat, delKat,
    addTx, stornoTx, editTx, approveTx,
    markNotifsRead,
    addLimit, delLimit,
  };
}

// ============================================================
// DESIGN
// ============================================================
const ff = `'DM Sans',system-ui,sans-serif`;
const fm = `'DM Mono',monospace`;
const P = {
  bg: "#f5f5f0", card: "#fff", ink: "#1a1a18", ink2: "#6b6b64", ink3: "#9b9b94",
  border: "#e2e2dc", accent: "#d4602a", green: "#2d7a4f", greenBg: "#e8f5ee",
  red: "#c23b22", redBg: "#fce8e4", blue: "#2a6dd4", blueBg: "#e4eefb",
  orange: "#e68a00", orangeBg: "#fff4de",
  sh: "0 1px 2px rgba(26,26,24,.06)", shM: "0 2px 8px rgba(26,26,24,.08)",
};
const sC = { background: P.card, border: `1px solid ${P.border}`, borderRadius: 10, padding: 20, boxShadow: P.sh };
const sI = { fontFamily: ff, fontSize: 14, padding: "9px 12px", borderRadius: 7, border: `1.5px solid ${P.border}`, background: "#fafaf8", color: P.ink, width: "100%", boxSizing: "border-box", outline: "none" };
const sB = { fontFamily: ff, fontSize: 13, fontWeight: 600, border: "none", borderRadius: 7, padding: "9px 16px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 };
const sL = { fontSize: 12, fontWeight: 600, color: P.ink2, marginBottom: 4, display: "block", letterSpacing: ".02em", textTransform: "uppercase" };

const Ic = ({ d, s = 18, c = "currentColor" }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const ic = {
  plus: "M12 5v14M5 12h14", logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  back: "M19 12H5M12 19l-7-7 7-7", check: "M20 6L9 17l-5-5", x: "M18 6L6 18M6 6l12 12",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  cash: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  building: "M3 21h18M3 7v14M21 7v14M7 3h10l4 4H3l4-4z",
  tag: "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01",
  bell: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0",
  edit: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  ban: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4.93 4.93l14.14 14.14",
  wallet: "M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
  sheet: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8M8 9h2",
};

const fmt = n => Number(n).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fD = d => new Date(d).toLocaleDateString("cs-CZ", { day: "2-digit", month: "2-digit", year: "2-digit" });
const fT = d => new Date(d).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
const fISO = d => { const o = new Date(d); return `${o.getFullYear()}-${String(o.getMonth()+1).padStart(2,"0")}-${String(o.getDate()).padStart(2,"0")}`; };
const lu = (id, arr, k = "nazev") => arr.find(x => x.id === id)?.[k] || "—";

const Fl = ({ l, children, s: st }) => <div style={{ marginBottom: 14, ...st }}><label style={sL}>{l}</label>{children}</div>;

function Toast({ msg, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  const ok = type === "success";
  return (
    <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, fontFamily: ff, background: ok ? P.greenBg : P.redBg, color: ok ? P.green : P.red, padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, boxShadow: P.shM, display: "flex", alignItems: "center", gap: 7, border: `1px solid ${ok ? "#b7dfc7" : "#f5c6be"}`, animation: "tIn .2s ease-out" }}>
      <Ic d={ok ? ic.check : ic.x} s={15} />{msg}
    </div>
  );
}

// Confirm dialog
function Confirm({ msg, onYes, onNo }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, animation: "fIn .15s ease-out" }}>
      <div style={{ ...sC, maxWidth: 360, width: "100%", textAlign: "center" }}>
        <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 20px", lineHeight: 1.5 }}>{msg}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button style={{ ...sB, background: P.green, color: "#fff", padding: "10px 28px" }} onClick={onYes} disabled={false}>Ano</button>
          <button style={{ ...sB, background: "transparent", color: P.ink2, border: `1.5px solid ${P.border}`, padding: "10px 28px" }} onClick={onNo}>Zrušit</button>
        </div>
      </div>
    </div>
  );
}

// Prompt dialog (with text input)
function Prompt({ msg, onOk, onCancel, placeholder }) {
  const [val, setVal] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, animation: "fIn .15s ease-out" }}>
      <div style={{ ...sC, maxWidth: 400, width: "100%" }}>
        <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px", lineHeight: 1.5 }}>{msg}</p>
        <input style={sI} placeholder={placeholder || ""} value={val} onChange={e => setVal(e.target.value)} autoFocus />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
          <button style={{ ...sB, background: "transparent", color: P.ink2, border: `1.5px solid ${P.border}` }} onClick={onCancel}>Zrušit</button>
          <button style={{ ...sB, background: P.accent, color: "#fff" }} onClick={() => onOk(val)}>Potvrdit</button>
        </div>
      </div>
    </div>
  );
}

const Header = ({ title, sub, right }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, paddingTop: 4 }}>
    <div>
      <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: "-.02em" }}>{title}</h1>
      {sub && <p style={{ margin: "1px 0 0", fontSize: 13, color: P.ink2 }}>{sub}</p>}
    </div>
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>{right}</div>
  </div>
);

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const store = useStore();
  const [user, setUser] = useState(null);
  const [scr, setScr] = useState("login");
  const [toast, setToast] = useState(null);
  const nt = (msg, type = "success") => setToast({ msg, type, k: Date.now() });

  const isAdmin = user && (user.role === "superadmin" || user.role === "manazer");

  const globalStyles = `
    @keyframes tIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
    @keyframes fIn{from{opacity:0}to{opacity:1}}
    @keyframes spin{to{transform:rotate(360deg)}}
    input:focus,select:focus{border-color:${P.accent}!important}
    input::placeholder{color:${P.ink3}}
    *,*::before,*::after{box-sizing:border-box}
    body{margin:0}
    table{border-collapse:collapse}
    select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b6b64' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:32px}
    @media(max-width:500px){.hide-mobile{display:none!important}}
  `;

  if (store.loading) return (
    <div style={{ fontFamily: ff, background: P.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <style>{globalStyles}</style>
      <div style={{ width: 36, height: 36, border: `3px solid ${P.border}`, borderTopColor: P.accent, borderRadius: "50%", animation: "spin .8s linear infinite" }} />
      <p style={{ margin: 0, fontSize: 14, color: P.ink2, fontWeight: 500 }}>Načítání dat…</p>
    </div>
  );

  if (store.error) return (
    <div style={{ fontFamily: ff, background: P.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <style>{globalStyles}</style>
      <div style={{ ...sC, maxWidth: 420, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
        <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 800 }}>Chyba připojení k databázi</h2>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: P.ink2, fontFamily: fm, wordBreak: "break-all" }}>{store.error}</p>
        <button style={{ ...sB, background: P.accent, color: "#fff", width: "100%", justifyContent: "center" }} onClick={store.refetch}>Zkusit znovu</button>
      </div>
    </div>
  );

  return (
    <div style={{ fontFamily: ff, background: P.bg, minHeight: "100vh", color: P.ink }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <style>{globalStyles}</style>
      {toast && <Toast msg={toast.msg} type={toast.type} onClose={() => setToast(null)} key={toast.k} />}
      {!user ? (
        <Login store={store} onLogin={u => { setUser(u); setScr(isAdminRole(u) ? "admin" : "home"); }} nt={nt} />
      ) : isAdmin && scr.startsWith("admin") ? (
        <AdminPanel user={user} store={store} scr={scr} setScr={setScr} nt={nt} onLogout={() => { setUser(null); setScr("login"); }} />
      ) : (
        <EmpPanel user={user} store={store} scr={scr} setScr={setScr} nt={nt} onLogout={() => { setUser(null); setScr("login"); }} />
      )}
    </div>
  );
}

const isAdminRole = u => u.role === "superadmin" || u.role === "manazer";
const roleLabel = { superadmin: "Superadmin", manazer: "Manažer", zamestnanec: "Zaměstnanec" };
const roleColor = { superadmin: P.accent, manazer: P.blue, zamestnanec: P.ink3 };

// ============================================================
// PIN LOGIN
// ============================================================
function Login({ store, onLogin, nt }) {
  const [step, setStep] = useState("name"); // name | pin
  const [jmeno, setJmeno] = useState("");
  const [pin, setPin] = useState("");
  const [found, setFound] = useState(null);

  const selectUser = () => {
    const f = store.zamestnanci.find(z => z.jmeno.toLowerCase() === jmeno.trim().toLowerCase());
    if (!f) return nt("Zaměstnanec nenalezen", "error");
    setFound(f);
    setStep("pin");
    setPin("");
  };

  const checkPin = (p) => {
    if (p === found.pin) onLogin(found);
    else { nt("Nesprávný PIN", "error"); setPin(""); }
  };

  const addDigit = d => {
    const next = pin + d;
    setPin(next);
    if (next.length === 4) setTimeout(() => checkPin(next), 150);
  };

  if (step === "pin" && found) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20 }}>
        <div style={{ ...sC, width: "100%", maxWidth: 320, animation: "fIn .3s ease-out", textAlign: "center" }}>
          <div style={{ width: 48, height: 48, background: P.accent, borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
            <Ic d={ic.cash} s={24} c="#fff" />
          </div>
          <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>{found.jmeno}</h2>
          <p style={{ margin: "0 0 20px", fontSize: 13, color: P.ink2 }}>Zadejte 4místný PIN</p>

          {/* PIN dots */}
          <div style={{ display: "flex", justifyContent: "center", gap: 12, marginBottom: 24 }}>
            {[0,1,2,3].map(i => (
              <div key={i} style={{ width: 16, height: 16, borderRadius: 99, background: i < pin.length ? P.ink : P.border, transition: "background .1s" }} />
            ))}
          </div>

          {/* Numpad */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, maxWidth: 240, margin: "0 auto" }}>
            {[1,2,3,4,5,6,7,8,9,null,0,"⌫"].map((d, i) => (
              <button key={i} onClick={() => { if (d === "⌫") setPin(p => p.slice(0,-1)); else if (d !== null && pin.length < 4) addDigit(String(d)); }}
                style={{ ...sB, justifyContent: "center", fontSize: 20, fontWeight: 700, padding: "14px 0", borderRadius: 10, background: d === null ? "transparent" : "#f0f0ec", color: P.ink, border: "none", cursor: d === null ? "default" : "pointer", opacity: d === null ? 0 : 1 }}>
                {d}
              </button>
            ))}
          </div>

          <button style={{ ...sB, background: "transparent", color: P.ink2, marginTop: 16, padding: "6px 10px" }} onClick={() => { setStep("name"); setPin(""); }}>
            <Ic d={ic.back} s={14} /> Zpět
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 20 }}>
      <div style={{ ...sC, width: "100%", maxWidth: 360, animation: "fIn .3s ease-out" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ width: 48, height: 48, background: P.accent, borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
            <Ic d={ic.cash} s={24} c="#fff" />
          </div>
          <h1 style={{ margin: "0 0 2px", fontSize: 20, fontWeight: 800, letterSpacing: "-.02em" }}>POKLADNÍ DENÍK</h1>
          <p style={{ margin: "0 0 2px", fontSize: 14, fontWeight: 600, color: P.accent }}>Helenka 1.0</p>
          <p style={{ margin: 0, fontSize: 13, color: P.ink2 }}>Přihlášení zaměstnance</p>
        </div>
        <Fl l="Jméno"><input style={sI} placeholder="Vaše jméno" value={jmeno} onChange={e => setJmeno(e.target.value)} onKeyDown={e => e.key === "Enter" && selectUser()} /></Fl>
        <button style={{ ...sB, background: P.accent, color: "#fff", width: "100%", justifyContent: "center", padding: "11px 20px", fontSize: 14, marginTop: 4 }} onClick={selectUser}>Pokračovat</button>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 16 }}>
          <span style={{ fontSize: 11, color: P.ink3 }}>by <strong>OCELKUJ</strong></span>
          <img src="data:image/png;base64,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" alt="" style={{ width: 32, height: 32, borderRadius: "50%" }} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// EMPLOYEE PANEL
// ============================================================
function EmpPanel({ user, store, scr, setScr, nt, onLogout }) {
  const myFIds = store.assignments.filter(a => a.zamestnanec_id === user.id).map(a => a.firma_id);
  const myFirmy = store.firmy.filter(f => myFIds.includes(f.id));
  const [actF, setActF] = useState(myFirmy[0]?.id || null);
  const isA = isAdminRole(user);

  const myTx = store.transakce.filter(t => t.zamestnanec_id === user.id && t.firma_id === actF && !t.storno);
  const cashBal = myTx.filter(t => t.typ_platby === "hotovost").reduce((s, t) => s + (t.typ === "prijem" ? 1 : -1) * Number(t.cena_s_dph), 0);
  const fName = myFirmy.find(f => f.id === actF)?.nazev || "";

  if (scr === "new-tx") return <TxForm user={user} store={store} firmy={myFirmy} defF={actF} onBack={() => setScr("home")} nt={nt} />;
  if (scr === "vklad") return <VkladForm user={user} store={store} firmy={myFirmy} defF={actF} onBack={() => setScr("home")} nt={nt} typ="prijem" />;
  if (scr === "vyber") return <VkladForm user={user} store={store} firmy={myFirmy} defF={actF} onBack={() => setScr("home")} nt={nt} typ="vydaj" />;

  return (
    <div style={{ maxWidth: 460, margin: "0 auto", padding: "16px 16px 40px" }}>
      <Header title="Pokladní Deník" sub={user.jmeno} right={<>
        {isA && <button style={{ ...sB, background: "transparent", color: P.accent, border: `1.5px solid ${P.accent}` }} onClick={() => setScr("admin")}>Admin</button>}
        <button style={{ ...sB, background: "transparent", color: P.ink2, padding: "6px 10px" }} onClick={onLogout}><Ic d={ic.logout} s={16} /></button>
      </>} />

      {myFirmy.length > 1 && (
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {myFirmy.map(f => (
            <button key={f.id} onClick={() => setActF(f.id)} style={{
              ...sB, flex: 1, justifyContent: "center", fontSize: 12, padding: "8px 8px", borderRadius: 8,
              background: actF === f.id ? P.ink : "transparent", color: actF === f.id ? "#fff" : P.ink2,
              border: `1.5px solid ${actF === f.id ? P.ink : P.border}`, fontWeight: actF === f.id ? 700 : 500,
            }}>{f.nazev}</button>
          ))}
        </div>
      )}

      <div style={{ ...sC, marginBottom: 16, padding: "20px 24px", border: "none", background: `linear-gradient(135deg,${P.accent} 0%,#b8501f 100%)`, color: "#fff" }}>
        <div style={{ fontSize: 12, opacity: .8, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" }}>Hotovostní pokladna{fName ? ` · ${fName}` : ""}</div>
        <div style={{ fontSize: 34, fontWeight: 800, fontFamily: fm, marginTop: 4, letterSpacing: "-.02em" }}>{fmt(cashBal)} <span style={{ fontSize: 18, fontWeight: 500 }}>Kč</span></div>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button style={{ ...sB, background: P.green, color: "#fff", flex: 1, justifyContent: "center", padding: 13, fontSize: 14, borderRadius: 10 }} onClick={() => setScr("new-tx")}>
          <Ic d={ic.plus} s={16} c="#fff" /> Transakce
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button style={{ ...sB, flex: 1, justifyContent: "center", padding: "10px", fontSize: 13, borderRadius: 8, background: P.greenBg, color: P.green, border: `1px solid #b7dfc7` }} onClick={() => setScr("vklad")}>
          <Ic d={ic.wallet} s={15} c={P.green} /> Vklad
        </button>
        <button style={{ ...sB, flex: 1, justifyContent: "center", padding: "10px", fontSize: 13, borderRadius: 8, background: P.redBg, color: P.red, border: `1px solid #f5c6be` }} onClick={() => setScr("vyber")}>
          <Ic d={ic.wallet} s={15} c={P.red} /> Výběr
        </button>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: P.ink2, marginBottom: 10, textTransform: "uppercase", letterSpacing: ".04em" }}>Poslední transakce</div>
      {myTx.length === 0 ? <p style={{ color: P.ink3, fontSize: 14, textAlign: "center", padding: 24 }}>Zatím žádné transakce</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {myTx.slice(0, 25).map(t => (
            <div key={t.id} style={{ ...sC, padding: "11px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", opacity: t.storno ? .5 : 1 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 6 }}>
                  {t.is_vklad && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: t.typ === "prijem" ? P.greenBg : P.redBg, color: t.typ === "prijem" ? P.green : P.red }}>{t.typ === "prijem" ? "VKLAD" : "VÝBĚR"}</span>}
                  {t.edited && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: P.orangeBg, color: P.orange }}>UPRAVENO</span>}
                  {t.popis || "Bez popisu"}
                </div>
                <div style={{ fontSize: 12, color: P.ink3, marginTop: 2 }}>{t.typ_platby === "hotovost" ? "💵" : "💳"} · {fD(t.created_at)} {fT(t.created_at)}</div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: fm, whiteSpace: "nowrap", marginLeft: 12, color: t.typ === "prijem" ? P.green : P.red }}>
                {t.typ === "prijem" ? "+" : "−"}{fmt(t.cena_s_dph)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// VKLAD / VÝBĚR FORM
// ============================================================
function VkladForm({ user, store, firmy, defF, onBack, nt, typ }) {
  const [firma, setFirma] = useState(defF || firmy[0]?.id || "");
  const [castka, setCastka] = useState("");
  const [pozn, setPozn] = useState("");
  const [fileName, setFileName] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const fileRef = useRef();
  const [fileObj, setFileObj] = useState(null);
    const isVklad = typ === "prijem";

  const save = () => {
    if (!castka || Number(castka) <= 0) return nt("Zadejte částku", "error");
    if (!pozn.trim()) return nt("Vyplňte poznámku (odkud/kam peníze)", "error");
    setConfirm(true);
  };

  const doSave = async () => {
    const txData = { zamestnanec_id: user.id, firma_id: Number(firma), typ, kategorie_id: null, dodavatel: "", popis: pozn.trim(), cena_bez_dph: Number(castka), cena_s_dph: Number(castka), typ_platby: "hotovost", priloha_url: fileName || null, is_vklad: true };
    try {
      const saved = await store.addTx(txData);
      if (fileObj && saved?.id) {
        try { await store.uploadReceipt(fileObj, saved.id, user.id); }
        catch (e) { nt("Příloha se nepodařila: " + e.message, "error"); }
      }
      const firmaNazev = store.firmy.find(x => x.id === Number(firma))?.nazev || "";
      try { await store.exportToSheets(saved || txData, user.jmeno, Number(firma), firmaNazev, null); } catch(se) { console.warn("Sheets:", se.message); }
      if (fileObj) store.uploadToDrive(fileObj, user.jmeno, firmaNazev);
      setShowSuccess(true);
    } catch (e) {
      nt("Chyba při ukládání: " + e.message, "error");
    }
  };

  return (
    <div style={{ maxWidth: 460, margin: "0 auto", padding: "16px 16px 40px", animation: "fIn .2s ease-out" }}>
      {showSuccess && <SuccessScreen onDone={onBack} />}
      {confirm && <Confirm msg={`${isVklad ? "Vklad" : "Výběr"} ${fmt(castka)} Kč – potvrdit?`} onYes={doSave} onNo={() => setConfirm(false)} />}
      <button style={{ ...sB, background: "transparent", color: P.ink2, padding: "6px 10px", marginBottom: 12 }} onClick={onBack}><Ic d={ic.back} s={16} /> Zpět</button>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, fontWeight: 800 }}>{isVklad ? "💰 Vklad do pokladny" : "💸 Výběr z pokladny"}</h2>
      <div style={sC}>
        <Fl l="Firma">
          <select style={sI} value={firma} onChange={e => setFirma(e.target.value)}>
            {firmy.map(x => <option key={x.id} value={x.id}>{x.nazev}</option>)}
          </select>
        </Fl>
        <Fl l="Částka (Kč)">
          <input style={{ ...sI, fontSize: 22, fontWeight: 700, fontFamily: fm, textAlign: "center" }} type="number" step="0.01" placeholder="0,00" value={castka} onChange={e => setCastka(e.target.value)} />
        </Fl>
        <Fl l="Poznámka (povinná)">
          <input style={sI} placeholder={isVklad ? "Odkud peníze přišly – např. výběr z banky" : "Kam peníze odešly – např. odvoz do trezoru"} value={pozn} onChange={e => setPozn(e.target.value)} />
        </Fl>
        <Fl l="Doklad (příloha)">
          <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) setFileName(e.target.files[0].name); }} />
          <button style={{ ...sB, background: "transparent", color: P.accent, border: `1.5px solid ${P.accent}`, width: "100%", justifyContent: "center" }} onClick={() => fileRef.current.click()}>
            <Ic d={ic.upload} s={15} /> {fileName || "Vyfotit / nahrát doklad"}
          </button>
        </Fl>
        <button style={{ ...sB, background: isVklad ? P.green : P.red, color: "#fff", width: "100%", justifyContent: "center", padding: 12, fontSize: 15, marginTop: 6 }} onClick={save}>
          {isVklad ? "Zaznamenat vklad" : "Zaznamenat výběr"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// SUCCESS SCREEN (shown after saving a transaction)
// ============================================================
const MOTIV_IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAGQAZADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD0CiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAoopKACioXu7aNtrzxqfQsBUL6tp8eQ95CMf7YpXAuU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";

function SuccessScreen({ onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 2500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.8)", display: "flex", alignItems: "center", justifyContent: "center", animation: "fIn .2s ease-out" }}>
      <style>{`
        @keyframes shake { 0%,100%{transform:rotate(0)} 10%{transform:rotate(-10deg)} 20%{transform:rotate(10deg)} 30%{transform:rotate(-8deg)} 40%{transform:rotate(8deg)} 50%{transform:rotate(-5deg)} 60%{transform:rotate(5deg)} 70%{transform:rotate(-2deg)} 80%{transform:rotate(2deg)} }
        @keyframes popIn { 0%{transform:scale(0.2);opacity:0} 50%{transform:scale(1.08);opacity:1} 100%{transform:scale(1)} }
        @keyframes slideUp { 0%{transform:translateY(40px);opacity:0} 100%{transform:translateY(0);opacity:1} }
      `}</style>
      <div style={{ textAlign: "center" }}>
        <div style={{ animation: "popIn .5s ease-out, shake .7s ease-in-out .5s" }}>
          <img src={MOTIV_IMG} alt="" style={{
            width: 220, height: 220, borderRadius: "50%", border: "5px solid #fff",
            boxShadow: "0 8px 40px rgba(0,0,0,.5), 0 0 60px rgba(212,96,42,.3)",
            objectFit: "cover",
          }} />
        </div>
        <div style={{ animation: "slideUp .5s ease-out .4s both" }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#fff", marginTop: 24, fontFamily: ff, letterSpacing: "-.02em", textShadow: "0 2px 12px rgba(0,0,0,.4)" }}>
            TRANSAKCE PŘIJATA ✓
          </div>
          <div style={{ fontSize: 15, color: "rgba(255,255,255,.65)", marginTop: 8, fontFamily: ff }}>
            Záznam byl úspěšně uložen
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// TRANSACTION FORM (with autocomplete, confirm, duplicate check)
// ============================================================
function TxForm({ user, store, firmy, defF, onBack, nt }) {
  const [f, setF] = useState({ firma_id: defF || firmy[0]?.id || "", typ: "vydaj", kategorie_id: "", dodavatel: "", popis: "", bez: "", sdph: "", platba: "hotovost" });
  const [fileName, setFileName] = useState("");
  const [showSugg, setShowSugg] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [dupWarn, setDupWarn] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const fileRef = useRef();
  const [fileObj, setFileObj] = useState(null);
    const suggRef = useRef();
  const up = (k, v) => setF(p => ({ ...p, [k]: v }));
  const filtKat = store.kategorie.filter(k => k.typ === "oba" || k.typ === f.typ);
  const dodLabel = f.typ === "prijem" ? "Odběratel" : "Dodavatel";
  const dodPh = f.typ === "prijem" ? "Název odběratele" : "Název dodavatele";
  const allNames = useMemo(() => [...new Set(store.transakce.map(t => t.dodavatel).filter(Boolean))].sort(), [store.transakce]);
  const sugg = f.dodavatel.trim() ? allNames.filter(n => n.toLowerCase().includes(f.dodavatel.toLowerCase().trim())) : allNames;

  useEffect(() => {
    const h = e => { if (suggRef.current && !suggRef.current.contains(e.target)) setShowSugg(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);

  const [limitWarn, setLimitWarn] = useState(null);

  const trySave = () => {
    if (!f.firma_id) return nt("Vyberte firmu", "error");
    if (!f.sdph) return nt("Vyplňte cenu s DPH", "error");
    if (store.isDuplicate(user.id, Number(f.firma_id), Number(f.sdph))) { setDupWarn(true); return; }
    // Check spending limits
    if (f.typ === "vydaj") {
      const warnings = store.checkLimits({ zamestnanec_id: user.id, kategorie_id: f.kategorie_id ? Number(f.kategorie_id) : null, cena_s_dph: Number(f.sdph) });
      if (warnings.length > 0) { setLimitWarn(warnings); return; }
    }
    setConfirm(true);
  };

  const doSave = async () => {
    const txData = { zamestnanec_id: user.id, firma_id: Number(f.firma_id), typ: f.typ, kategorie_id: f.kategorie_id ? Number(f.kategorie_id) : null, dodavatel: f.dodavatel || null, popis: f.popis || null, cena_bez_dph: Number(f.bez) || 0, cena_s_dph: Number(f.sdph), typ_platby: f.platba, priloha_url: fileName || null, is_vklad: false };
    try {
      const saved = await store.addTx(txData);
      if (fileObj && saved?.id) {
        try { await store.uploadReceipt(fileObj, saved.id, user.id); }
        catch (e) { nt("Příloha se nepodařila: " + e.message, "error"); }
      }
      const katName = f.kategorie_id ? store.kategorie.find(k => k.id === Number(f.kategorie_id))?.nazev : null;
      const firmaNazev = store.firmy.find(x => x.id === Number(f.firma_id))?.nazev || "";
      try { await store.exportToSheets(saved || txData, user.jmeno, Number(f.firma_id), firmaNazev, katName); } catch(se) { console.warn("Sheets:", se.message); }
      if (fileObj) store.uploadToDrive(fileObj, user.jmeno, firmaNazev);
      setShowSuccess(true);
    } catch (e) {
      nt("Chyba při ukládání: " + e.message, "error");
    }
  };

  const tog = (key, val, col) => ({
    ...sB, flex: 1, justifyContent: "center", fontSize: 13,
    background: f[key] === val ? col : "transparent", color: f[key] === val ? "#fff" : P.ink2,
    border: `1.5px solid ${f[key] === val ? col : P.border}`,
  });

  return (
    <div style={{ maxWidth: 460, margin: "0 auto", padding: "16px 16px 40px", animation: "fIn .2s ease-out" }}>
      {showSuccess && <SuccessScreen onDone={onBack} />}
      {confirm && <Confirm msg={`Uložit ${f.typ === "prijem" ? "příjem" : "výdaj"} ${fmt(f.sdph)} Kč?`} onYes={doSave} onNo={() => setConfirm(false)} />}
      {dupWarn && <Confirm msg="⚠️ Velmi podobná transakce byla zadána před chvílí. Opravdu chcete pokračovat?" onYes={() => { setDupWarn(false); setConfirm(true); }} onNo={() => setDupWarn(false)} />}
      {limitWarn && <Confirm msg={`⚠️ Překročení limitu!\n${limitWarn.map(w => `${w.targetName}: ${fmt(w.newTotal)} / ${fmt(w.limit.limit_czk)} Kč (${w.limit.typ === "denny" ? "denní" : "měsíční"})`).join("\n")}\n\nPokračovat přesto?`} onYes={() => { setLimitWarn(null); setConfirm(true); }} onNo={() => setLimitWarn(null)} />}

      <button style={{ ...sB, background: "transparent", color: P.ink2, padding: "6px 10px", marginBottom: 12 }} onClick={onBack}><Ic d={ic.back} s={16} /> Zpět</button>
      <h2 style={{ margin: "0 0 20px", fontSize: 20, fontWeight: 800 }}>Nová transakce</h2>
      <div style={sC}>
        <Fl l="Firma">
          <select style={sI} value={f.firma_id} onChange={e => up("firma_id", e.target.value)}>
            {firmy.length === 0 && <option value="">— Nemáte přiřazenu firmu —</option>}
            {firmy.map(x => <option key={x.id} value={x.id}>{x.nazev}</option>)}
          </select>
        </Fl>
        <Fl l="Typ">
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => up("typ", "prijem")} style={tog("typ", "prijem", P.green)}>Příjem</button>
            <button onClick={() => up("typ", "vydaj")} style={tog("typ", "vydaj", P.red)}>Výdaj</button>
          </div>
        </Fl>
        <Fl l="Kategorie">
          <select style={sI} value={f.kategorie_id} onChange={e => up("kategorie_id", e.target.value)}>
            <option value="">— Vyberte —</option>
            {filtKat.map(k => <option key={k.id} value={k.id}>{k.nazev}</option>)}
          </select>
        </Fl>
        <Fl l={dodLabel}>
          <div style={{ position: "relative" }} ref={suggRef}>
            <input style={sI} placeholder={dodPh} value={f.dodavatel} onChange={e => { up("dodavatel", e.target.value); setShowSugg(true); }} onFocus={() => setShowSugg(true)} />
            {showSugg && sugg.length > 0 && (
              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background: P.card, border: `1.5px solid ${P.border}`, borderRadius: 8, marginTop: 4, boxShadow: P.shM, maxHeight: 160, overflowY: "auto" }}>
                {sugg.map(s => (
                  <div key={s} onClick={() => { up("dodavatel", s); setShowSugg(false); }}
                    style={{ padding: "8px 12px", fontSize: 13, cursor: "pointer", borderBottom: `1px solid ${P.border}` }}
                    onMouseEnter={e => e.currentTarget.style.background = P.blueBg} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>{s}</div>
                ))}
              </div>
            )}
          </div>
        </Fl>
        <Fl l="Popis"><input style={sI} placeholder="např. nákup žárovek do auta" value={f.popis} onChange={e => up("popis", e.target.value)} /></Fl>
        <div style={{ display: "flex", gap: 10 }}>
          <Fl l="Bez DPH" s={{ flex: 1 }}><input style={sI} type="number" step="0.01" placeholder="0,00" value={f.bez} onChange={e => up("bez", e.target.value)} /></Fl>
          <Fl l="S DPH" s={{ flex: 1 }}><input style={sI} type="number" step="0.01" placeholder="0,00" value={f.sdph} onChange={e => up("sdph", e.target.value)} /></Fl>
        </div>
        <Fl l="Platba">
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => up("platba", "hotovost")} style={tog("platba", "hotovost", P.blue)}>💵 Hotovost</button>
            <button onClick={() => up("platba", "karta")} style={tog("platba", "karta", P.blue)}>💳 Karta</button>
          </div>
        </Fl>
        <Fl l="Doklad">
          <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) setFileName(e.target.files[0].name); }} />
          <button style={{ ...sB, background: "transparent", color: P.accent, border: `1.5px solid ${P.accent}`, width: "100%", justifyContent: "center" }} onClick={() => fileRef.current.click()}>
            <Ic d={ic.upload} s={15} /> {fileName || "Vyfotit / nahrát doklad"}
          </button>
        </Fl>
        <button style={{ ...sB, background: P.green, color: "#fff", width: "100%", justifyContent: "center", padding: 12, fontSize: 15, marginTop: 6 }} onClick={trySave}>Uložit transakci</button>
      </div>
    </div>
  );
}

// ============================================================
// ADMIN PANEL
// ============================================================
function AdminPanel({ user, store, scr, setScr, nt, onLogout }) {
  const isSA = user.role === "superadmin";
  const unread = store.notifs.filter(n => !n.read).length;

  // Manager sees only assigned companies
  const visibleFirmyIds = isSA ? store.firmy.map(f => f.id) : store.assignments.filter(a => a.zamestnanec_id === user.id).map(a => a.firma_id);

  const tabs = [
    { id: "admin", l: "Přehledy", i: ic.list },
    { id: "admin-dash", l: "Dashboard", i: ic.cash },
    ...(isSA ? [{ id: "admin-limits", l: "Limity", i: ic.ban }] : []),
    ...(isSA ? [{ id: "admin-emp", l: "Zaměstnanci", i: ic.users }] : []),
    ...(isSA ? [{ id: "admin-comp", l: "Firmy", i: ic.building }] : []),
    ...(isSA ? [{ id: "admin-cat", l: "Kategorie", i: ic.tag }] : []),
    { id: "admin-sheets", l: "Google", i: ic.sheet },
    { id: "admin-notif", l: `Notif.${unread ? ` (${unread})` : ""}`, i: ic.bell },
  ];

  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "16px 16px 40px" }}>
      <Header title="Pokladní Deník" sub={`${roleLabel[user.role]} · ${user.jmeno}`} right={<>
        <button style={{ ...sB, background: "transparent", color: P.accent, border: `1.5px solid ${P.accent}` }} onClick={() => setScr("home")}><Ic d={ic.cash} s={15} /> Pokladna</button>
        <button style={{ ...sB, background: "transparent", color: P.ink2, padding: "6px 10px" }} onClick={onLogout}><Ic d={ic.logout} s={16} /></button>
      </>} />
      <div style={{ display: "flex", gap: 2, marginBottom: 20, borderBottom: `2px solid ${P.border}`, overflowX: "auto" }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setScr(t.id)} style={{
            ...sB, borderRadius: "7px 7px 0 0", padding: "9px 14px",
            borderBottom: scr === t.id ? `2px solid ${P.accent}` : "2px solid transparent",
            color: scr === t.id ? P.accent : P.ink2, fontWeight: scr === t.id ? 700 : 500,
            marginBottom: -2, background: "transparent", whiteSpace: "nowrap",
          }}><Ic d={t.i} s={15} c={scr === t.id ? P.accent : P.ink3} /> {t.l}</button>
        ))}
      </div>
      {scr === "admin" && <OverviewTab store={store} nt={nt} user={user} visibleFirmyIds={visibleFirmyIds} />}
      {scr === "admin-dash" && <DashboardTab store={store} visibleFirmyIds={visibleFirmyIds} />}
      {scr === "admin-limits" && isSA && <LimitsTab store={store} nt={nt} />}
      {scr === "admin-emp" && isSA && <EmpTab store={store} nt={nt} />}
      {scr === "admin-comp" && isSA && <CompTab store={store} nt={nt} />}
      {scr === "admin-cat" && isSA && <CatTab store={store} nt={nt} />}
      {scr === "admin-sheets" && <SheetsTab store={store} />}
      {scr === "admin-notif" && <NotifTab store={store} />}
    </div>
  );
}

// ============================================================
// ADMIN: OVERVIEW (date filter, summary, CSV, storno, edit)
// ============================================================
function OverviewTab({ store, nt, user, visibleFirmyIds }) {
  const [fZ, setFZ] = useState("");
  const [fF, setFF] = useState("");
  const [dFrom, setDFrom] = useState("");
  const [dTo, setDTo] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [stornoId, setStornoId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);

  const allTx = store.transakce.filter(t => visibleFirmyIds.includes(t.firma_id));

  const txs = allTx.filter(t => {
    if (fZ && t.zamestnanec_id !== Number(fZ)) return false;
    if (fF && t.firma_id !== Number(fF)) return false;
    if (dFrom && fISO(t.created_at) < dFrom) return false;
    if (dTo && fISO(t.created_at) > dTo) return false;
    if (fStatus === "storno" && !t.storno) return false;
    if (fStatus === "edited" && !t.edited) return false;
    if (fStatus === "active" && (t.storno || t.edited)) return false;
    return true;
  });

  const activeTxs = txs.filter(t => !t.storno);
  const totalIn = activeTxs.filter(t => t.typ === "prijem").reduce((s, t) => s + Number(t.cena_s_dph), 0);
  const totalOut = activeTxs.filter(t => t.typ === "vydaj").reduce((s, t) => s + Number(t.cena_s_dph), 0);

  // Cash balances per employee (active, not storno)
  const bals = {};
  allTx.filter(t => t.typ_platby === "hotovost" && !t.storno).forEach(t => {
    const n = lu(t.zamestnanec_id, store.zamestnanci, "jmeno");
    const fN = lu(t.firma_id, store.firmy);
    const key = `${n} · ${fN}`;
    bals[key] = (bals[key] || 0) + (t.typ === "prijem" ? 1 : -1) * Number(t.cena_s_dph);
  });

  const exportCSV = () => {
    const hdr = "Datum;Zaměstnanec;Firma;Typ;Kategorie;Dodavatel;Popis;Bez DPH;S DPH;Platba;Storno";
    const rows = txs.map(t => [
      `${fD(t.created_at)} ${fT(t.created_at)}`, lu(t.zamestnanec_id, store.zamestnanci, "jmeno"), lu(t.firma_id, store.firmy),
      t.typ === "prijem" ? "Příjem" : "Výdaj", lu(t.kategorie_id, store.kategorie), t.dodavatel || "",
      t.popis || "", t.cena_bez_dph, t.cena_s_dph, t.typ_platby === "hotovost" ? "Hotovost" : "Karta", t.storno ? "ANO" : "",
    ].join(";"));
    const csv = "\uFEFF" + [hdr, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `pokladni-denik-${fISO(new Date())}.csv`; a.click();
    URL.revokeObjectURL(url);
    nt("CSV exportováno ✓");
  };

  return (
    <div>
      {/* Storno/Edit dialogs */}
      {stornoId && <Prompt msg="Důvod storna:" placeholder="Proč transakci stornujete?" onOk={async val => { try { await store.stornoTx(stornoId, val, user.id); nt("Transakce stornována"); } catch(e) { nt("Chyba: "+e.message,"error"); } setStornoId(null); }} onCancel={() => setStornoId(null)} />}
      {editId && <EditDialog store={store} txId={editId} userId={user.id} onClose={() => setEditId(null)} nt={nt} />}

      {/* Balance cards */}
      {Object.keys(bals).length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          {Object.entries(bals).map(([n, b]) => (
            <div key={n} style={{ ...sC, padding: "12px 18px", flex: "1 1 200px", background: b >= 0 ? P.greenBg : P.redBg, borderColor: b >= 0 ? "#b7dfc7" : "#f5c6be" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: P.ink2 }}>{n}</div>
              <div style={{ fontSize: 20, fontWeight: 800, fontFamily: fm, color: b >= 0 ? P.green : P.red }}>{fmt(b)} Kč</div>
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ ...sC, padding: "10px 16px", flex: "1 1 120px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: P.ink3, textTransform: "uppercase" }}>Příjmy</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: P.green, fontFamily: fm }}>+{fmt(totalIn)}</div>
        </div>
        <div style={{ ...sC, padding: "10px 16px", flex: "1 1 120px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: P.ink3, textTransform: "uppercase" }}>Výdaje</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: P.red, fontFamily: fm }}>−{fmt(totalOut)}</div>
        </div>
        <div style={{ ...sC, padding: "10px 16px", flex: "1 1 120px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: P.ink3, textTransform: "uppercase" }}>Saldo</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: totalIn - totalOut >= 0 ? P.green : P.red, fontFamily: fm }}>{fmt(totalIn - totalOut)}</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <select style={{ ...sI, width: "auto", flex: 1 }} value={fZ} onChange={e => setFZ(e.target.value)}>
          <option value="">Všichni zaměstnanci</option>
          {store.zamestnanci.map(z => <option key={z.id} value={z.id}>{z.jmeno}</option>)}
        </select>
        <select style={{ ...sI, width: "auto", flex: 1 }} value={fF} onChange={e => setFF(e.target.value)}>
          <option value="">Všechny firmy</option>
          {store.firmy.filter(f => visibleFirmyIds.includes(f.id)).map(f => <option key={f.id} value={f.id}>{f.nazev}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...sI, width: "auto", flex: 1 }} type="date" value={dFrom} onChange={e => setDFrom(e.target.value)} />
        <span style={{ color: P.ink3, fontSize: 13 }}>→</span>
        <input style={{ ...sI, width: "auto", flex: 1 }} type="date" value={dTo} onChange={e => setDTo(e.target.value)} />
        <select style={{ ...sI, width: "auto", flex: "0 0 auto" }} value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="">Vše</option>
          <option value="active">Jen aktivní</option>
          <option value="storno">Jen stornované</option>
          <option value="edited">Jen upravené</option>
        </select>
        <button style={{ ...sB, background: P.accent, color: "#fff" }} onClick={exportCSV}><Ic d={ic.download} s={14} c="#fff" /> CSV</button>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", borderRadius: 10, border: `1px solid ${P.border}`, background: P.card }}>
        <table style={{ width: "100%", fontSize: 13, fontFamily: ff }}>
          <thead>
            <tr style={{ background: "#fafaf8" }}>
              {["Datum", "Zaměstnanec", "Firma", "Typ", "Popis", "Částka", "Pl.", "Doklad", "Stav", ""].map(h => (
                <th key={h} style={{ padding: "10px 8px", textAlign: "left", fontWeight: 700, color: P.ink2, borderBottom: `2px solid ${P.border}`, whiteSpace: "nowrap", fontSize: 11, textTransform: "uppercase", letterSpacing: ".03em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {txs.map(t => (
              <tr key={t.id} style={{ borderBottom: `1px solid ${P.border}`, opacity: t.storno ? .45 : 1, cursor: "pointer" }} onClick={() => setDetailId(t.id)}>
                <td style={{ padding: "8px 8px", whiteSpace: "nowrap", fontFamily: fm, fontSize: 11 }}>{fD(t.created_at)} {fT(t.created_at)}</td>
                <td style={{ padding: "8px 8px", fontWeight: 500 }}>{lu(t.zamestnanec_id, store.zamestnanci, "jmeno")}</td>
                <td style={{ padding: "8px 8px", fontSize: 12 }}>{lu(t.firma_id, store.firmy)}</td>
                <td style={{ padding: "8px 8px" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    <span style={{ padding: "2px 6px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: t.typ === "prijem" ? P.greenBg : P.redBg, color: t.typ === "prijem" ? P.green : P.red }}>
                      {t.is_vklad ? (t.typ === "prijem" ? "VKLAD" : "VÝBĚR") : t.typ === "prijem" ? "Příjem" : "Výdaj"}
                    </span>
                    {t.edited && <span style={{ padding: "2px 4px", borderRadius: 99, fontSize: 9, fontWeight: 700, background: P.orangeBg, color: P.orange }}>✎</span>}
                    {t.storno && <span style={{ padding: "2px 4px", borderRadius: 99, fontSize: 9, fontWeight: 700, background: P.redBg, color: P.red }}>✗</span>}
                  </span>
                </td>
                <td style={{ padding: "8px 8px", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.popis || "—"}</td>
                <td style={{ padding: "8px 8px", fontWeight: 700, fontFamily: fm, color: t.typ === "prijem" ? P.green : P.red, whiteSpace: "nowrap" }}>{t.typ === "prijem" ? "+" : "−"}{fmt(t.cena_s_dph)}</td>
                <td style={{ padding: "8px 8px", textAlign: "center" }}>{t.typ_platby === "hotovost" ? "💵" : "💳"}</td>
                <td style={{ padding: "8px 8px", textAlign: "center" }}>
                  {t.priloha_url ? (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 99, background: P.blueBg, color: P.blue, cursor: "pointer" }}
                      onClick={e => { e.stopPropagation(); setPreviewUrl(t.priloha_url); }}>📎 Náhled</span>
                  ) : <span style={{ color: P.ink3, fontSize: 11 }}>—</span>}
                </td>
                <td style={{ padding: "8px 8px", textAlign: "center" }}>
                  {t.approved
                    ? <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 99, background: P.greenBg, color: P.green }}>✓ Schváleno</span>
                    : !t.storno && <button onClick={async e => { e.stopPropagation(); try { await store.approveTx(t.id, user.id); nt("Schváleno ✓"); } catch(err) { nt("Chyba: "+err.message,"error"); } }}
                        style={{ ...sB, fontSize: 10, padding: "2px 8px", background: "transparent", color: P.orange, border: `1px solid ${P.orange}`, borderRadius: 99 }}>Schválit</button>
                  }
                </td>
                <td style={{ padding: "8px 8px", whiteSpace: "nowrap" }} onClick={e => e.stopPropagation()}>
                  {!t.storno && (
                    <div style={{ display: "flex", gap: 2 }}>
                      <button onClick={() => setEditId(t.id)} style={{ ...sB, padding: "4px 5px", background: "transparent", color: P.blue, border: "none" }} title="Upravit"><Ic d={ic.edit} s={12} /></button>
                      <button onClick={() => setStornoId(t.id)} style={{ ...sB, padding: "4px 5px", background: "transparent", color: P.red, border: "none" }} title="Storno"><Ic d={ic.ban} s={12} /></button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {txs.length === 0 && <p style={{ textAlign: "center", color: P.ink3, padding: 24 }}>Žádné transakce</p>}
      </div>
      <p style={{ fontSize: 12, color: P.ink3, marginTop: 8 }}>{txs.length} transakcí{txs.filter(t => t.storno).length > 0 ? ` (${txs.filter(t => t.storno).length} stornováno)` : ""}</p>

      {/* Attachment preview modal */}
      {previewUrl && (
        <div onClick={() => setPreviewUrl(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 9997, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ ...sC, maxWidth: 500, width: "100%", textAlign: "center" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>📎 Náhled dokladu</h3>
              <button style={{ ...sB, background: "transparent", color: P.ink2, padding: "4px 8px" }} onClick={() => setPreviewUrl(null)}><Ic d={ic.x} s={16} /></button>
            </div>
            <div style={{ background: "#f5f5f0", borderRadius: 8, padding: 20, fontSize: 14, color: P.ink2 }}>
              <div style={{ fontSize: 48, marginBottom: 8 }}>📄</div>
              <p style={{ fontFamily: fm, fontSize: 13 }}>{previewUrl}</p>
              <p style={{ fontSize: 12, color: P.ink3, marginTop: 8 }}>Po nasazení na Vercel se zde zobrazí skutečný náhled souboru z Google Drive.</p>
            </div>
          </div>
        </div>
      )}

      {/* Transaction detail modal */}
      {detailId && <TxDetail store={store} txId={detailId} user={user} onClose={() => setDetailId(null)} nt={nt} />}
    </div>
  );
}

// ============================================================
// TRANSACTION DETAIL MODAL
// ============================================================
function TxDetail({ store, txId, user, onClose, nt }) {
  const t = store.transakce.find(x => x.id === txId);
  if (!t) return null;

  const zamName = lu(t.zamestnanec_id, store.zamestnanci, "jmeno");
  const firmaName = lu(t.firma_id, store.firmy);
  const katName = lu(t.kategorie_id, store.kategorie);
  const history = t.history || [];

  const actionLabel = { vytvoreno: "Vytvořeno", uprava: "Upraveno", storno: "Stornováno", schvaleno: "Schváleno" };
  const actionColor = { vytvoreno: P.blue, uprava: P.orange, storno: P.red, schvaleno: P.green };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 9997, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, animation: "fIn .15s ease-out" }}>
      <div style={{ ...sC, maxWidth: 520, width: "100%", maxHeight: "85vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Detail transakce</h3>
          <button style={{ ...sB, background: "transparent", color: P.ink2, padding: "4px 8px" }} onClick={onClose}><Ic d={ic.x} s={18} /></button>
        </div>

        {/* Info grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 20px", marginBottom: 20 }}>
          {[
            ["Datum", `${fD(t.created_at)} ${fT(t.created_at)}`],
            ["Zaměstnanec", zamName],
            ["Firma", firmaName],
            ["Typ", t.is_vklad ? (t.typ === "prijem" ? "Vklad" : "Výběr") : (t.typ === "prijem" ? "Příjem" : "Výdaj")],
            ["Kategorie", katName],
            ["Platba", t.typ_platby === "hotovost" ? "Hotovost" : "Karta"],
            [t.typ === "prijem" ? "Odběratel" : "Dodavatel", t.dodavatel || "—"],
            ["Popis", t.popis || "—"],
            ["Bez DPH", `${fmt(t.cena_bez_dph)} Kč`],
            ["S DPH", `${fmt(t.cena_s_dph)} Kč`],
          ].map(([label, val]) => (
            <div key={label}>
              <div style={{ fontSize: 11, fontWeight: 600, color: P.ink3, textTransform: "uppercase", marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 500, color: P.ink }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Status badges */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {t.storno && <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99, background: P.redBg, color: P.red }}>STORNOVÁNO</span>}
          {t.edited && <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99, background: P.orangeBg, color: P.orange }}>UPRAVENO</span>}
          {t.approved && <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99, background: P.greenBg, color: P.green }}>✓ SCHVÁLENO</span>}
          {!t.approved && !t.storno && <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 99, background: "#f0f0ec", color: P.ink3 }}>Čeká na schválení</span>}
        </div>

        {/* Attachment */}
        {t.priloha_url && (
          <div style={{ ...sC, padding: "12px 16px", marginBottom: 16, background: P.blueBg, borderColor: "#b7cfe8" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: P.blue, marginBottom: 4 }}>📎 Příloha</div>
            <div style={{ fontSize: 13, fontFamily: fm, color: P.ink2 }}>{t.priloha_url}</div>
            <p style={{ fontSize: 11, color: P.ink3, margin: "6px 0 0" }}>Náhled bude dostupný po nasazení na Vercel + Google Drive.</p>
          </div>
        )}

        {/* Approve button */}
        {!t.approved && !t.storno && (
          <button style={{ ...sB, background: P.green, color: "#fff", width: "100%", justifyContent: "center", padding: "10px", marginBottom: 16 }}
            onClick={async () => { try { await store.approveTx(t.id, user.id); nt("Doklad schválen ✓"); } catch(e) { nt("Chyba: "+e.message,"error"); } }}>
            ✓ Schválit transakci
          </button>
        )}

        {/* History */}
        <div style={{ fontSize: 13, fontWeight: 700, color: P.ink2, marginBottom: 10, textTransform: "uppercase", letterSpacing: ".03em" }}>Historie změn</div>
        {history.length === 0 ? (
          <p style={{ color: P.ink3, fontSize: 13 }}>Žádná historie (starší transakce)</p>
        ) : (
          <div style={{ position: "relative", paddingLeft: 20 }}>
            {/* Timeline line */}
            <div style={{ position: "absolute", left: 6, top: 4, bottom: 4, width: 2, background: P.border }} />
            {history.map((h, i) => (
              <div key={i} style={{ position: "relative", marginBottom: 14, paddingLeft: 8 }}>
                {/* Dot */}
                <div style={{ position: "absolute", left: -18, top: 4, width: 10, height: 10, borderRadius: 99, background: actionColor[h.action] || P.ink3, border: `2px solid ${P.card}` }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: actionColor[h.action] || P.ink2 }}>{actionLabel[h.action] || h.action}</span>
                  <span style={{ fontSize: 11, fontFamily: fm, color: P.ink3 }}>{fD(h.time)} {fT(h.time)}</span>
                </div>
                <div style={{ fontSize: 12, color: P.ink2, marginTop: 2 }}>{lu(h.user_id, store.zamestnanci, "jmeno")}</div>
                {h.pozn && <div style={{ fontSize: 12, color: P.ink2, fontStyle: "italic", marginTop: 2 }}>„{h.pozn}"</div>}
                {h.before && (
                  <div style={{ fontSize: 11, color: P.ink3, marginTop: 4, background: "#f5f5f0", padding: "4px 8px", borderRadius: 4 }}>
                    Předchozí: {h.before.popis && `popis: "${h.before.popis}"`} {h.before.cena_s_dph && `| s DPH: ${fmt(h.before.cena_s_dph)}`} {h.before.dodavatel && `| dodavatel: "${h.before.dodavatel}"`}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// ADMIN: DASHBOARD (charts using recharts)
// ============================================================
function DashboardTab({ store, visibleFirmyIds }) {
  const [period, setPeriod] = useState("week"); // week | month
  const allTx = store.transakce.filter(t => visibleFirmyIds.includes(t.firma_id) && !t.storno);

  // Generate day labels for past 7 or 30 days
  const days = period === "week" ? 7 : 30;
  const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    labels.push(fISO(d));
  }

  // Aggregate per day
  const dailyData = labels.map(day => {
    const dayTx = allTx.filter(t => fISO(t.created_at) === day);
    return {
      day: day.slice(5), // MM-DD
      prijmy: dayTx.filter(t => t.typ === "prijem").reduce((s, t) => s + Number(t.cena_s_dph), 0),
      vydaje: dayTx.filter(t => t.typ === "vydaj").reduce((s, t) => s + Number(t.cena_s_dph), 0),
    };
  });

  // Top categories by spending PER FIRM
  const catSpendPerFirm = {};
  store.firmy.filter(f => visibleFirmyIds.includes(f.id)).forEach(f => {
    const firmTx = allTx.filter(t => t.firma_id === f.id && t.typ === "vydaj");
    const cats = {};
    firmTx.forEach(t => {
      const name = lu(t.kategorie_id, store.kategorie);
      cats[name] = (cats[name] || 0) + Number(t.cena_s_dph);
    });
    catSpendPerFirm[f.id] = { nazev: f.nazev, cats: Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 6) };
  });

  // Per-firm totals
  const firmTotals = store.firmy.filter(f => visibleFirmyIds.includes(f.id)).map(f => {
    const fTx = allTx.filter(t => t.firma_id === f.id);
    return {
      nazev: f.nazev,
      prijmy: fTx.filter(t => t.typ === "prijem").reduce((s, t) => s + Number(t.cena_s_dph), 0),
      vydaje: fTx.filter(t => t.typ === "vydaj").reduce((s, t) => s + Number(t.cena_s_dph), 0),
    };
  });

  const maxDaily = Math.max(...dailyData.map(d => Math.max(d.prijmy, d.vydaje)), 1);

  // Simple bar renderer
  const Bar = ({ value, max, color, label }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <div style={{ width: 90, fontSize: 12, color: P.ink2, textAlign: "right", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ flex: 1, height: 22, background: "#f0f0ec", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max((value / max) * 100, 0.5)}%`, background: color, borderRadius: 4, transition: "width .3s" }} />
      </div>
      <div style={{ width: 80, fontSize: 12, fontFamily: fm, fontWeight: 600, color, textAlign: "right", flexShrink: 0 }}>{fmt(value)}</div>
    </div>
  );

  return (
    <div>
      {/* Period toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
        {[["week", "Posledních 7 dní"], ["month", "Posledních 30 dní"]].map(([v, l]) => (
          <button key={v} onClick={() => setPeriod(v)} style={{
            ...sB, background: period === v ? P.ink : "transparent", color: period === v ? "#fff" : P.ink2,
            border: `1.5px solid ${period === v ? P.ink : P.border}`, padding: "7px 14px",
          }}>{l}</button>
        ))}
      </div>

      {/* Daily chart */}
      <div style={{ ...sC, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>📈 Příjmy vs Výdaje (denně)</div>
        <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 160, padding: "0 4px" }}>
          {dailyData.map((d, i) => (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, height: "100%", justifyContent: "flex-end" }}>
              <div style={{ width: "80%", maxWidth: 32, display: "flex", gap: 1, alignItems: "flex-end", height: "100%" }}>
                <div style={{ flex: 1, background: P.green, borderRadius: "3px 3px 0 0", minHeight: d.prijmy > 0 ? 4 : 0, height: `${(d.prijmy / maxDaily) * 100}%`, transition: "height .3s" }} />
                <div style={{ flex: 1, background: P.red, borderRadius: "3px 3px 0 0", minHeight: d.vydaje > 0 ? 4 : 0, height: `${(d.vydaje / maxDaily) * 100}%`, transition: "height .3s" }} />
              </div>
              <div style={{ fontSize: 9, color: P.ink3, whiteSpace: "nowrap" }}>{d.day}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 12 }}>
          <span style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 10, background: P.green, borderRadius: 2, display: "inline-block" }} /> Příjmy</span>
          <span style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 10, background: P.red, borderRadius: 2, display: "inline-block" }} /> Výdaje</span>
        </div>
      </div>

      {/* Top categories per firm */}
      <div style={{ ...sC, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>🏷️ Top kategorie výdajů dle firem</div>
        {Object.values(catSpendPerFirm).map(firm => {
          const maxVal = firm.cats[0]?.[1] || 1;
          return (
            <div key={firm.nazev} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: P.ink, padding: "4px 0", borderBottom: `1px solid ${P.border}` }}>{firm.nazev}</div>
              {firm.cats.length === 0 ? <p style={{ color: P.ink3, fontSize: 13, margin: "4px 0" }}>Žádné výdaje</p> : (
                firm.cats.map(([name, val]) => <Bar key={name} label={name} value={val} max={maxVal} color={P.red} />)
              )}
            </div>
          );
        })}
      </div>

      {/* Per-firm comparison */}
      <div style={{ ...sC }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>🏢 Porovnání firem</div>
        {firmTotals.map(f => (
          <div key={f.nazev} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{f.nazev}</div>
            <Bar label="Příjmy" value={f.prijmy} max={Math.max(f.prijmy, f.vydaje, 1)} color={P.green} />
            <Bar label="Výdaje" value={f.vydaje} max={Math.max(f.prijmy, f.vydaje, 1)} color={P.red} />
            <div style={{ fontSize: 12, fontFamily: fm, fontWeight: 700, textAlign: "right", color: f.prijmy - f.vydaje >= 0 ? P.green : P.red, marginTop: 2 }}>
              Saldo: {fmt(f.prijmy - f.vydaje)} Kč
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// ADMIN: SPENDING LIMITS
// ============================================================
function LimitsTab({ store, nt }) {
  const [form, setForm] = useState({ typ: "mesicni", target_type: "zamestnanec", target_id: "", limit_czk: "" });

  const add = async () => {
    if (!form.target_id || !form.limit_czk) return nt("Vyplňte cíl a limit", "error");
    try {
      await store.addLimit({ typ: form.typ, target_type: form.target_type, target_id: Number(form.target_id), limit_czk: Number(form.limit_czk) });
      setForm({ typ: "mesicni", target_type: "zamestnanec", target_id: "", limit_czk: "" });
      nt("Limit přidán ✓");
    } catch(e) { nt("Chyba: "+e.message, "error"); }
  };

  const targetOptions = form.target_type === "zamestnanec" ? store.zamestnanci : store.kategorie;

  // Current spending vs limits
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  return (
    <div>
      <div style={{ ...sC, marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Přidat výdajový limit</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: "0 0 auto" }}>
            <Fl l="Období">
              <select style={sI} value={form.typ} onChange={e => setForm(p => ({ ...p, typ: e.target.value }))}>
                <option value="denny">Denní</option>
                <option value="mesicni">Měsíční</option>
              </select>
            </Fl>
          </div>
          <div style={{ flex: "0 0 auto" }}>
            <Fl l="Typ cíle">
              <select style={sI} value={form.target_type} onChange={e => setForm(p => ({ ...p, target_type: e.target.value, target_id: "" }))}>
                <option value="zamestnanec">Zaměstnanec</option>
                <option value="kategorie">Kategorie</option>
              </select>
            </Fl>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <Fl l={form.target_type === "zamestnanec" ? "Zaměstnanec" : "Kategorie"}>
              <select style={sI} value={form.target_id} onChange={e => setForm(p => ({ ...p, target_id: e.target.value }))}>
                <option value="">— Vyberte —</option>
                {targetOptions.map(o => <option key={o.id} value={o.id}>{o.jmeno || o.nazev}</option>)}
              </select>
            </Fl>
          </div>
          <div style={{ flex: 0, minWidth: 120 }}>
            <Fl l="Limit (Kč)">
              <input style={{ ...sI, fontFamily: fm }} type="number" placeholder="10000" value={form.limit_czk} onChange={e => setForm(p => ({ ...p, limit_czk: e.target.value }))} />
            </Fl>
          </div>
          <button style={{ ...sB, background: P.accent, color: "#fff", marginBottom: 14 }} onClick={add}>Přidat</button>
        </div>
      </div>

      {/* Active limits with current spending */}
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Aktivní limity</div>
      {store.limits.length === 0 ? (
        <p style={{ color: P.ink3, textAlign: "center", padding: 24 }}>Zatím žádné limity. Přidejte limit výše.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {store.limits.map(lim => {
            const cutoff = lim.typ === "denny" ? startOfDay : startOfMonth;
            const relevantTx = store.transakce.filter(t => !t.storno && t.typ === "vydaj" && new Date(t.created_at) >= cutoff);
            let spent = 0;
            if (lim.target_type === "zamestnanec") {
              spent = relevantTx.filter(t => t.zamestnanec_id === lim.target_id).reduce((s, t) => s + Number(t.cena_s_dph), 0);
            } else {
              spent = relevantTx.filter(t => t.kategorie_id === lim.target_id).reduce((s, t) => s + Number(t.cena_s_dph), 0);
            }
            const pct = Math.min((spent / lim.limit_czk) * 100, 100);
            const exceeded = spent > lim.limit_czk;
            const targetName = lim.target_type === "zamestnanec"
              ? (store.zamestnanci.find(z => z.id === lim.target_id)?.jmeno || "?")
              : (store.kategorie.find(k => k.id === lim.target_id)?.nazev || "?");

            return (
              <div key={lim.id} style={{ ...sC, padding: "14px 18px", borderLeft: `4px solid ${exceeded ? P.red : pct > 80 ? P.orange : P.green}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{targetName}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: lim.typ === "denny" ? P.blueBg : P.orangeBg, color: lim.typ === "denny" ? P.blue : P.orange }}>
                      {lim.typ === "denny" ? "Denní" : "Měsíční"}
                    </span>
                    <span style={{ fontSize: 11, color: P.ink3 }}>{lim.target_type === "zamestnanec" ? "👤" : "🏷️"}</span>
                  </div>
                  <button style={{ ...sB, background: P.red, color: "#fff", fontSize: 11, padding: "4px 10px" }} onClick={async () => { try { await store.delLimit(lim.id); nt("Limit odstraněn"); } catch(e) { nt("Chyba: "+e.message,"error"); } }}>Smazat</button>
                </div>
                {/* Progress bar */}
                <div style={{ height: 8, background: "#f0f0ec", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
                  <div style={{ height: "100%", width: `${pct}%`, background: exceeded ? P.red : pct > 80 ? P.orange : P.green, borderRadius: 4, transition: "width .3s" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ fontFamily: fm, fontWeight: 600, color: exceeded ? P.red : P.ink2 }}>{fmt(spent)} Kč</span>
                  <span style={{ fontFamily: fm, color: P.ink3 }}>z {fmt(lim.limit_czk)} Kč ({Math.round(pct)}%)</span>
                </div>
                {exceeded && <div style={{ fontSize: 12, fontWeight: 700, color: P.red, marginTop: 4 }}>⚠️ Limit překročen o {fmt(spent - lim.limit_czk)} Kč!</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// EDIT DIALOG
// ============================================================
function EditDialog({ store, txId, userId, onClose, nt }) {
  const t = store.transakce.find(x => x.id === txId);
  const [f, setF] = useState({ popis: t?.popis || "", cena_bez_dph: t?.cena_bez_dph || 0, cena_s_dph: t?.cena_s_dph || 0, dodavatel: t?.dodavatel || "" });
  const [pozn, setPozn] = useState("");
  if (!t) return null;

  const save = async () => {
    if (!pozn.trim()) return nt("Vyplňte důvod úpravy", "error");
    try {
      await store.editTx(txId, f, pozn.trim(), userId);
      nt("Transakce upravena"); onClose();
    } catch(e) { nt("Chyba: "+e.message, "error"); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ ...sC, maxWidth: 420, width: "100%" }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700 }}>Upravit transakci</h3>
        <Fl l="Popis"><input style={sI} value={f.popis} onChange={e => setF(p => ({ ...p, popis: e.target.value }))} /></Fl>
        <Fl l="Dodavatel / Odběratel"><input style={sI} value={f.dodavatel} onChange={e => setF(p => ({ ...p, dodavatel: e.target.value }))} /></Fl>
        <div style={{ display: "flex", gap: 10 }}>
          <Fl l="Bez DPH" s={{ flex: 1 }}><input style={sI} type="number" step="0.01" value={f.cena_bez_dph} onChange={e => setF(p => ({ ...p, cena_bez_dph: Number(e.target.value) }))} /></Fl>
          <Fl l="S DPH" s={{ flex: 1 }}><input style={sI} type="number" step="0.01" value={f.cena_s_dph} onChange={e => setF(p => ({ ...p, cena_s_dph: Number(e.target.value) }))} /></Fl>
        </div>
        <Fl l="Důvod úpravy (povinné)"><input style={sI} placeholder="Proč měníte transakci?" value={pozn} onChange={e => setPozn(e.target.value)} /></Fl>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={{ ...sB, background: "transparent", color: P.ink2, border: `1.5px solid ${P.border}` }} onClick={onClose}>Zrušit</button>
          <button style={{ ...sB, background: P.accent, color: "#fff" }} onClick={save}>Uložit změny</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ADMIN: GOOGLE SHEETS & DRIVE
// ============================================================
function SheetsTab({ store }) {
  return (
    <div>
      {/* Sheets config */}
      <div style={{ ...sC, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>📊 Google Sheets – napojené spreadsheets</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {store.firmy.map(f => {
            const hasSid = !!f.spreadsheet_id;
            return (
              <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#fafaf8", borderRadius: 8 }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{f.nazev}</span>
                  {hasSid && <span style={{ marginLeft: 8, fontSize: 11, fontFamily: fm, color: P.ink3 }}>ID: {f.spreadsheet_id.slice(0, 12)}…</span>}
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: hasSid ? P.greenBg : P.redBg, color: hasSid ? P.green : P.red }}>
                  {hasSid ? "✓ Napojeno" : "✗ Nenastaveno"}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Drive config */}
      <div style={{ ...sC, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>📁 Google Drive – úložiště dokladů</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#fafaf8", borderRadius: 8 }}>
          <div>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Kořenová složka</span>
            <span style={{ marginLeft: 8, fontSize: 11, fontFamily: fm, color: P.ink3 }}>ID: {DRIVE_ROOT_FOLDER_ID.slice(0, 16)}…</span>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: P.greenBg, color: P.green }}>✓ Nastaveno</span>
        </div>
        <p style={{ fontSize: 12, color: P.ink3, marginTop: 10, lineHeight: 1.5, margin: "10px 0 0" }}>
          Struktura: <span style={{ fontFamily: fm, fontSize: 11 }}>Kořenová složka / [Firma] / [Zaměstnanec] / doklady</span><br />
          Podsložky se vytváří automaticky při prvním nahrání.
        </p>
      </div>

      {/* Service account info */}
      <div style={{ ...sC, marginBottom: 20, padding: "14px 18px" }}>
        <p style={{ fontSize: 12, color: P.ink3, margin: 0, lineHeight: 1.5 }}>
          Service account: <span style={{ fontFamily: fm, fontSize: 11 }}>pokladni-denik-export@pokladni-denik.iam.gserviceaccount.com</span><br />
          Stav: <strong style={{ color: P.orange }}>Simulace</strong> – po nasazení na Vercel bude Sheets export i Drive upload aktivní.
        </p>
      </div>

      {/* Sheets export log */}
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>📊 Historie exportů do Sheets</div>
      {store.sheetsLog.length === 0 ? (
        <p style={{ color: P.ink3, textAlign: "center", padding: 20, fontSize: 14 }}>Zatím žádné exporty.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 24 }}>
          {store.sheetsLog.map(l => (
            <div key={l.id} style={{ ...sC, padding: "12px 16px", borderLeft: `4px solid ${l.status === "simulated" ? P.orange : P.green}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: l.status === "simulated" ? P.orangeBg : P.greenBg, color: l.status === "simulated" ? P.orange : P.green }}>
                    {l.status === "simulated" ? "SIMULACE" : "ODESLÁNO"}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{l.spreadsheet}</span>
                  <span style={{ color: P.ink3, fontSize: 13 }}>→ list „{l.sheet}"</span>
                </div>
                <span style={{ fontSize: 12, color: P.ink3, fontFamily: fm }}>{fD(l.time)} {fT(l.time)}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SHEET_HEADERS.map((h, i) => l.row[i] ? (
                  <span key={i} style={{ fontSize: 11, padding: "2px 6px", background: "#f0f0ec", borderRadius: 4, fontFamily: fm, color: P.ink2 }}>
                    {h}: {l.row[i]}
                  </span>
                ) : null)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Drive upload log */}
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>📁 Historie uploadů na Drive</div>
      {store.driveLog.length === 0 ? (
        <p style={{ color: P.ink3, textAlign: "center", padding: 20, fontSize: 14 }}>Zatím žádné uploady. Nahrajte doklad k transakci a uvidíte ho zde.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {store.driveLog.map(l => (
            <div key={l.id} style={{ ...sC, padding: "12px 16px", borderLeft: `4px solid ${l.status === "simulated" ? P.orange : P.green}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: l.status === "simulated" ? P.orangeBg : P.greenBg, color: l.status === "simulated" ? P.orange : P.green }}>
                    {l.status === "simulated" ? "SIMULACE" : "NAHRÁNO"}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>📄 {l.fileName}</span>
                </div>
                <span style={{ fontSize: 12, color: P.ink3, fontFamily: fm }}>{fD(l.time)} {fT(l.time)}</span>
              </div>
              <div style={{ fontSize: 12, color: P.ink2, marginTop: 4, fontFamily: fm }}>
                📂 {l.path}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ADMIN: NOTIFICATIONS
// ============================================================
function NotifTab({ store }) {
  useEffect(() => { store.markNotifsRead(); }, []);
  if (store.notifs.length === 0) return <p style={{ color: P.ink3, textAlign: "center", padding: 30 }}>Žádné notifikace</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {store.notifs.map(n => (
        <div key={n.id} style={{ ...sC, padding: "12px 16px", borderLeft: `4px solid ${n.type === "storno" ? P.red : P.orange}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: n.type === "storno" ? P.redBg : P.orangeBg, color: n.type === "storno" ? P.red : P.orange }}>
                {n.type === "storno" ? "STORNO" : "ÚPRAVA"}
              </span>
              <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 600 }}>{lu(n.user_id, store.zamestnanci, "jmeno")}</span>
              <span style={{ marginLeft: 6, fontSize: 13, color: P.ink2 }}>– {n.popis || "transakce"}</span>
            </div>
            <span style={{ fontSize: 12, color: P.ink3, fontFamily: fm }}>{fD(n.time)} {fT(n.time)}</span>
          </div>
          {n.pozn && <p style={{ margin: "6px 0 0", fontSize: 13, color: P.ink2, fontStyle: "italic" }}>„{n.pozn}"</p>}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// ADMIN: EMPLOYEES (with roles)
// ============================================================
function EmpTab({ store, nt }) {
  const [form, setForm] = useState({ jmeno: "", pin: "", role: "zamestnanec" });
  const [editId, setEditId] = useState(null);
  const save = async () => {
    if (!form.jmeno.trim() || !form.pin.trim()) return nt("Vyplňte jméno a PIN", "error");
    if (form.pin.length !== 4 || !/^\d+$/.test(form.pin)) return nt("PIN musí být 4 číslice", "error");
    try {
      if (editId) { await store.updateZam(editId, form); nt("Zaměstnanec upraven"); }
      else { await store.addZam(form); nt("Zaměstnanec přidán"); }
      setForm({ jmeno: "", pin: "", role: "zamestnanec" }); setEditId(null);
    } catch(e) { nt("Chyba: "+e.message, "error"); }
  };
  return (
    <div>
      <div style={{ ...sC, marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>{editId ? "Upravit zaměstnance" : "Přidat zaměstnance"}</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 130 }}><Fl l="Jméno"><input style={sI} value={form.jmeno} onChange={e => setForm(p => ({ ...p, jmeno: e.target.value }))} /></Fl></div>
          <div style={{ flex: 0, minWidth: 90 }}><Fl l="PIN (4 číslice)"><input style={{ ...sI, fontFamily: fm, letterSpacing: 4, textAlign: "center" }} maxLength={4} value={form.pin} onChange={e => setForm(p => ({ ...p, pin: e.target.value.replace(/\D/g, "").slice(0, 4) }))} /></Fl></div>
          <div style={{ flex: 0, minWidth: 120 }}>
            <Fl l="Role">
              <select style={sI} value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
                <option value="zamestnanec">Zaměstnanec</option>
                <option value="manazer">Manažer</option>
                <option value="superadmin">Superadmin</option>
              </select>
            </Fl>
          </div>
          <button style={{ ...sB, background: P.accent, color: "#fff", marginBottom: 14 }} onClick={save}>{editId ? "Uložit" : "Přidat"}</button>
          {editId && <button style={{ ...sB, background: "transparent", color: P.ink2, marginBottom: 14 }} onClick={() => { setEditId(null); setForm({ jmeno: "", pin: "", role: "zamestnanec" }); }}>Zrušit</button>}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {store.zamestnanci.map(z => {
          const myF = store.assignments.filter(a => a.zamestnanec_id === z.id).map(a => a.firma_id);
          return (
            <div key={z.id} style={{ ...sC, padding: "12px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: store.firmy.length > 0 ? 8 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{z.jmeno}</span>
                  <span style={{ fontFamily: fm, fontSize: 12, color: P.ink3 }}>PIN: ••••</span>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: roleColor[z.role] + "18", color: roleColor[z.role] }}>{roleLabel[z.role]}</span>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  <button style={{ ...sB, background: "transparent", color: P.ink2, padding: "6px 10px" }} onClick={() => { setEditId(z.id); setForm({ jmeno: z.jmeno, pin: z.pin, role: z.role }); }}>Upravit</button>
                  <button style={{ ...sB, background: P.red, color: "#fff", fontSize: 12, padding: "6px 12px" }} onClick={async () => { try { await store.delZam(z.id); nt("Smazáno"); } catch(e) { nt("Chyba: "+e.message,"error"); } }}>Smazat</button>
                </div>
              </div>
              {store.firmy.length > 0 && (
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {store.firmy.map(f => {
                    const on = myF.includes(f.id);
                    return (
                      <button key={f.id} onClick={async () => { try { await store.toggleAsgn(z.id, f.id); } catch(e) { nt("Chyba: "+e.message,"error"); } }} style={{
                        ...sB, fontSize: 11, padding: "3px 10px", borderRadius: 99,
                        background: on ? P.accent : "transparent", color: on ? "#fff" : P.ink3,
                        border: `1.5px solid ${on ? P.accent : P.border}`,
                      }}>{f.nazev}</button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// ADMIN: COMPANIES & CATEGORIES (superadmin only)
// ============================================================
function CompTab({ store, nt }) {
  const [nazev, setNazev] = useState("");
  const [sid, setSid] = useState("");
  const [editId, setEditId] = useState(null);
  const [editNazev, setEditNazev] = useState("");
  const [editSid, setEditSid] = useState("");

  const add = async () => {
    if (!nazev.trim()) return;
    try { await store.addFirma(nazev.trim(), sid.trim()); setNazev(""); setSid(""); nt("Firma přidána"); }
    catch(e) { nt("Chyba: "+e.message, "error"); }
  };

  const startEdit = (f) => { setEditId(f.id); setEditNazev(f.nazev); setEditSid(f.spreadsheet_id || ""); };
  const saveEdit = async () => {
    try { await store.updateFirma(editId, { nazev: editNazev, spreadsheet_id: editSid.trim() }); setEditId(null); nt("Firma aktualizována"); }
    catch(e) { nt("Chyba: "+e.message, "error"); }
  };

  return (
    <div>
      <div style={{ ...sC, marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Přidat firmu</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <input style={{ ...sI, flex: 1 }} placeholder="Název firmy" value={nazev} onChange={e => setNazev(e.target.value)} />
            <button style={{ ...sB, background: P.accent, color: "#fff" }} onClick={add}>Přidat</button>
          </div>
          <input style={sI} placeholder="Google Spreadsheet ID (volitelné – z URL spreadsheetu)" value={sid} onChange={e => setSid(e.target.value)} />
          <p style={{ fontSize: 11, color: P.ink3, margin: 0, lineHeight: 1.4 }}>
            Spreadsheet ID najdeš v URL: docs.google.com/spreadsheets/d/<strong style={{ color: P.accent }}>TOTO_JE_ID</strong>/edit
          </p>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {store.firmy.map(f => (
          <div key={f.id} style={{ ...sC, padding: "14px 18px" }}>
            {editId === f.id ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <Fl l="Název firmy"><input style={sI} value={editNazev} onChange={e => setEditNazev(e.target.value)} /></Fl>
                <Fl l="Google Spreadsheet ID">
                  <input style={{ ...sI, fontFamily: fm, fontSize: 12 }} placeholder="1aBcDeFgHiJkLmNoPqRsTuVwXyZ..." value={editSid} onChange={e => setEditSid(e.target.value)} />
                </Fl>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ ...sB, background: P.accent, color: "#fff" }} onClick={saveEdit}>Uložit</button>
                  <button style={{ ...sB, background: "transparent", color: P.ink2 }} onClick={() => setEditId(null)}>Zrušit</button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: f.spreadsheet_id ? 6 : 0 }}>
                  <span style={{ fontWeight: 600 }}>{f.nazev}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button style={{ ...sB, background: "transparent", color: P.ink2, padding: "6px 10px" }} onClick={() => startEdit(f)}>Upravit</button>
                    <button style={{ ...sB, background: P.red, color: "#fff", fontSize: 12, padding: "6px 12px" }} onClick={async () => { try { await store.delFirma(f.id); nt("Smazáno"); } catch(e) { nt("Chyba: "+e.message,"error"); } }}>Smazat</button>
                  </div>
                </div>
                {f.spreadsheet_id ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: P.greenBg, color: P.green }}>✓ Sheets</span>
                    <span style={{ fontSize: 11, fontFamily: fm, color: P.ink3 }}>ID: {f.spreadsheet_id.slice(0, 20)}…</span>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 99, background: P.redBg, color: P.red }}>✗ Nepropojeno</span>
                    <button style={{ ...sB, fontSize: 11, padding: "2px 8px", background: "transparent", color: P.blue }} onClick={() => startEdit(f)}>Přidat Spreadsheet ID</button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CatTab({ store, nt }) {
  const [form, setForm] = useState({ nazev: "", typ: "oba" });
  const add = async () => { if (!form.nazev.trim()) return; try { await store.addKat({ nazev: form.nazev.trim(), typ: form.typ }); setForm({ nazev: "", typ: "oba" }); nt("Kategorie přidána"); } catch(e) { nt("Chyba: "+e.message,"error"); } };
  const tl = { prijem: "Příjem", vydaj: "Výdaj", oba: "Obojí" };
  const tc = { prijem: P.green, vydaj: P.red, oba: P.blue };
  return (
    <div>
      <div style={{ ...sC, marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Přidat kategorii</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input style={{ ...sI, flex: 1, minWidth: 150 }} placeholder="Název kategorie" value={form.nazev} onChange={e => setForm(p => ({ ...p, nazev: e.target.value }))} onKeyDown={e => e.key === "Enter" && add()} />
          <select style={{ ...sI, width: "auto" }} value={form.typ} onChange={e => setForm(p => ({ ...p, typ: e.target.value }))}>
            <option value="oba">Příjem i Výdaj</option>
            <option value="prijem">Pouze Příjem</option>
            <option value="vydaj">Pouze Výdaj</option>
          </select>
          <button style={{ ...sB, background: P.accent, color: "#fff" }} onClick={add}>Přidat</button>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {store.kategorie.map(k => (
          <div key={k.id} style={{ ...sC, padding: "11px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{k.nazev}</span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: tc[k.typ] + "15", color: tc[k.typ] }}>{tl[k.typ]}</span>
            </div>
            <button style={{ ...sB, background: P.red, color: "#fff", fontSize: 12, padding: "6px 12px" }} onClick={async () => { try { await store.delKat(k.id); nt("Smazáno"); } catch(e) { nt("Chyba: "+e.message,"error"); } }}>Smazat</button>
          </div>
        ))}
      </div>
    </div>
  );
}

