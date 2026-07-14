/*************************************************************
 * 支票日曆 — Google Apps Script 後端 API（v2）
 * 前端改由 GitHub Pages 的網頁呼叫，這裡只當資料庫 + 辨識代理。
 * 分頁 Checks / Customers 會自動建立。
 * 掃描需在「專案設定 → 指令碼屬性」加入 ANTHROPIC_API_KEY。
 *************************************************************/

var SHEET_CHECKS = 'Checks';
var SHEET_CUST   = 'Customers';
var CHECK_HEADERS = ['id','bank','branch','accountNumber','checkNumber','dueDate','amount','receivedDate','customerName','cashed','createdAt'];
var CUST_HEADERS  = ['accountNumber','name','bank','branch'];

function doGet()  { return json_({ ok: true, service: '支票日曆 API' }); }

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (req.action) {
      case 'getData':        out = getData(); break;
      case 'saveCheck':      out = saveCheck(req.check); break;
      case 'deleteCheck':    out = deleteCheck(req.id); break;
      case 'setCashed':      out = setCashed(req.id, req.cashed); break;
      case 'renameCustomer': out = renameCustomer(req.accountNumber, req.name); break;
      case 'scan':           out = scanCheck(req.base64, req.mediaType); break;
      default:               out = { error: 'UNKNOWN_ACTION' };
    }
  } catch (err) { out = { error: String(err) }; }
  return json_(out);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Sheets ---------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, headers) {
  var ss = ss_(); var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); }
  else if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}
function d2s_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

function getData() {
  var shC = sheet_(SHEET_CHECKS, CHECK_HEADERS), shU = sheet_(SHEET_CUST, CUST_HEADERS);
  var checks = [], cvals = shC.getDataRange().getValues();
  for (var i = 1; i < cvals.length; i++) {
    var r = cvals[i]; if (!r[0]) continue;
    checks.push({
      id: String(r[0]), bank: String(r[1] || ''), branch: String(r[2] || ''),
      accountNumber: String(r[3] || ''), checkNumber: String(r[4] || ''),
      dueDate: d2s_(r[5]), amount: r[6] === '' ? '' : Number(r[6]),
      receivedDate: d2s_(r[7]), customerName: String(r[8] || ''),
      cashed: r[9] === true || r[9] === 'TRUE' || r[9] === 'true', createdAt: String(r[10] || '')
    });
  }
  var customers = {}, uvals = shU.getDataRange().getValues();
  for (var j = 1; j < uvals.length; j++) {
    var u = uvals[j]; if (!u[0]) continue;
    customers[String(u[0])] = { name: String(u[1] || ''), bank: String(u[2] || ''), branch: String(u[3] || '') };
  }
  return { checks: checks, customers: customers };
}

function findRow_(sh, id) {
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) if (String(vals[i][0]) === String(id)) return i + 1;
  return -1;
}
function upsertCustomer_(acct, name, bank, branch) {
  var sh = sheet_(SHEET_CUST, CUST_HEADERS), r = findRow_(sh, acct);
  if (r > 0) {
    var cur = sh.getRange(r, 1, 1, CUST_HEADERS.length).getValues()[0];
    sh.getRange(r, 1, 1, CUST_HEADERS.length).setValues([[acct, name || cur[1] || '', bank || cur[2] || '', branch || cur[3] || '']]);
  } else sh.appendRow([acct, name || '', bank || '', branch || '']);
}

function saveCheck(chk) {
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try {
    var sh = sheet_(SHEET_CHECKS, CHECK_HEADERS);
    var row = [chk.id, chk.bank || '', chk.branch || '', chk.accountNumber || '', chk.checkNumber || '',
      chk.dueDate || '', (chk.amount === '' || chk.amount == null) ? '' : Number(chk.amount),
      chk.receivedDate || '', chk.customerName || '', !!chk.cashed, chk.createdAt || new Date().toISOString()];
    var r = findRow_(sh, chk.id);
    if (r > 0) sh.getRange(r, 1, 1, CHECK_HEADERS.length).setValues([row]); else sh.appendRow(row);
    if (chk.accountNumber && chk.customerName) upsertCustomer_(chk.accountNumber, chk.customerName, chk.bank, chk.branch);
    return getData();
  } finally { lock.releaseLock(); }
}
function deleteCheck(id) {
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try { var sh = sheet_(SHEET_CHECKS, CHECK_HEADERS), r = findRow_(sh, id); if (r > 0) sh.deleteRow(r); return getData(); }
  finally { lock.releaseLock(); }
}
function setCashed(id, cashed) {
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try { var sh = sheet_(SHEET_CHECKS, CHECK_HEADERS), r = findRow_(sh, id); if (r > 0) sh.getRange(r, 10).setValue(!!cashed); return getData(); }
  finally { lock.releaseLock(); }
}
function renameCustomer(acct, name) {
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try {
    upsertCustomer_(acct, name);
    var sh = sheet_(SHEET_CHECKS, CHECK_HEADERS), vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) if (String(vals[i][3]) === String(acct)) sh.getRange(i + 1, 9).setValue(name);
    return getData();
  } finally { lock.releaseLock(); }
}

/* ---------- 掃描辨識 ---------- */
function scanCheck(base64, mediaType) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return { error: 'NO_KEY' };
  var prompt = '請閱讀這張台灣的銀行支票（票據）影像，擷取欄位後只回傳一個 JSON 物件，不要有任何說明文字或 markdown。格式：'
    + '{"bank":"銀行名稱","branch":"分行","accountNumber":"付款人帳號","checkNumber":"支票號碼/票號","dueDate":"到期日 YYYY-MM-DD(民國年請換算成西元年)","amount":數字}。'
    + '無法辨識的欄位填空字串或 null。';
  var payload = {
    model: 'claude-sonnet-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
      { type: 'text', text: prompt }
    ]}]
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return { error: 'API_' + res.getResponseCode() };
  var data = JSON.parse(res.getContentText());
  var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
  var s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) return { error: 'PARSE' };
  var p; try { p = JSON.parse(text.substring(s, e + 1)); } catch (err) { return { error: 'PARSE' }; }
  return {
    bank: p.bank || '', branch: p.branch || '',
    accountNumber: p.accountNumber ? String(p.accountNumber) : '',
    checkNumber: p.checkNumber ? String(p.checkNumber) : '',
    dueDate: p.dueDate || '',
    amount: (p.amount === null || p.amount === undefined) ? '' : Number(String(p.amount).replace(/[^0-9.]/g, ''))
  };
}
