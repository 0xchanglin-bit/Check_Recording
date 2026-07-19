/*************************************************************
 * 支票日曆 — Google Apps Script 後端 API（v3）
 * 新增：自票/客票 分辨、帳號正規化（去 - 與開頭 0）
 *************************************************************/

var SHEET_CHECKS = 'Checks';
var SHEET_CUST   = 'Customers';
var CHECK_HEADERS = ['id','bank','branch','accountNumber','checkNumber','dueDate','amount','receivedDate','customerName','cashed','createdAt','checkType','drawer'];
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
      case 'parseVoice':     out = parseVoice(req.text); break;
      default:               out = { error: 'UNKNOWN_ACTION' };
    }
  } catch (err) { out = { error: String(err) }; }
  return json_(out);
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* 帳號正規化：只留數字、去掉開頭的 0 */
function normAcct_(s) {
  return String(s == null ? '' : s).replace(/[^0-9]/g, '').replace(/^0+/, '');
}

/* ---------- Sheets ---------- */
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, headers) {
  var ss = ss_(); var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); sh.setFrozenRows(1); return sh; }
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); return sh; }
  if (sh.getLastColumn() < headers.length) sh.getRange(1, 1, 1, headers.length).setValues([headers]); // 升級舊表頭
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
      cashed: r[9] === true || r[9] === 'TRUE' || r[9] === 'true', createdAt: String(r[10] || ''),
      checkType: String(r[11] || 'own'), drawer: String(r[12] || '')
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
  var key = normAcct_(acct); if (!key) return;
  var sh = sheet_(SHEET_CUST, CUST_HEADERS), r = findRow_(sh, key);
  if (r > 0) {
    var cur = sh.getRange(r, 1, 1, CUST_HEADERS.length).getValues()[0];
    sh.getRange(r, 1, 1, CUST_HEADERS.length).setValues([[key, name || cur[1] || '', bank || cur[2] || '', branch || cur[3] || '']]);
  } else sh.appendRow([key, name || '', bank || '', branch || '']);
}

function saveCheck(chk) {
  var lock = LockService.getScriptLock(); lock.tryLock(20000);
  try {
    var sh = sheet_(SHEET_CHECKS, CHECK_HEADERS);
    var acct = normAcct_(chk.accountNumber);
    var type = chk.checkType === 'third' ? 'third' : 'own';
    var row = [chk.id, chk.bank || '', chk.branch || '', acct, chk.checkNumber || '',
      chk.dueDate || '', (chk.amount === '' || chk.amount == null) ? '' : Number(chk.amount),
      chk.receivedDate || '', chk.customerName || '', !!chk.cashed, chk.createdAt || new Date().toISOString(),
      type, chk.drawer || ''];
    var r = findRow_(sh, chk.id);
    if (r > 0) sh.getRange(r, 1, 1, CHECK_HEADERS.length).setValues([row]); else sh.appendRow(row);
    // 只有「自票」才把帳號存成客戶；客票的帳號屬票主，不留存
    if (type !== 'third' && acct && chk.customerName) upsertCustomer_(acct, chk.customerName, chk.bank, chk.branch);
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
    var key = normAcct_(acct);
    upsertCustomer_(key, name);
    var sh = sheet_(SHEET_CHECKS, CHECK_HEADERS), vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) if (normAcct_(vals[i][3]) === key) sh.getRange(i + 1, 9).setValue(name);
    return getData();
  } finally { lock.releaseLock(); }
}

/* ---------- 掃描辨識 ---------- */
function scanCheck(base64, mediaType) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return { error: 'NO_KEY' };
  var prompt = '請閱讀這張台灣的銀行支票（票據）影像，擷取欄位後只回傳一個 JSON 物件，不要有任何說明文字或 markdown。格式：'
    + '{"bank":"銀行名稱","branch":"分行","accountNumber":"付款人帳號","checkNumber":"支票號碼/票號（可能是英文字母加數字，如 YM0782517，請完整保留字母並轉大寫）","dueDate":"到期日 YYYY-MM-DD(民國年請換算成西元年)","amount":數字}。'
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

/* ---------- 語音口述解析（文字 → 支票欄位） ---------- */
function parseVoice(text) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return { error: 'NO_KEY' };
  if (!text || !String(text).trim()) return { error: 'EMPTY' };

  var tz = Session.getScriptTimeZone();
  var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  var prompt =
    '你是台灣中小企業的收票助理。以下是老闆用口述唸出的一張支票資訊（語音轉文字，可能有錯字或漏字）。\n'
    + '請把它整理成 JSON，只回傳 JSON 物件，不要任何說明文字或 markdown。\n\n'
    + '今天的日期是 ' + todayStr + '（用來推算相對日期）。\n\n'
    + '格式：\n'
    + '{"bank":"銀行名稱","branch":"分行(不含「分行」二字亦可)","accountNumber":"帳號(純數字)",'
    + '"checkNumber":"支票號碼/票號","dueDate":"到期日 YYYY-MM-DD","amount":數字,"customerName":"客戶名稱"}\n\n'
    + '規則：\n'
    + '1. 國字數字要轉成阿拉伯數字，例如「五八三零四九二」→ 5830492、「三萬五千八」→ 35800、「兩萬」→ 20000。\n'
    + '2. 帳號只保留數字，去掉「-」與空格。票號可能是「英文字母＋數字」（台灣支票常見 2 碼英文開頭，如 YM0782517、LD0267094、WR2505957），'
    + '請保留英文字母並轉成大寫，去掉空格與「-」。\n'
    + '2a. 語音轉文字常把唸出的英文字母寫成中文諧音或全形字，請還原成英文字母。常見對應：'
    + '歪/YY→Y、愛母/欸母/M→M、愛爾/L→L、低/迪/D→D、雙U/W→W、阿爾/R→R、西/C→C、批/P→P、'
    + '欸/A→A、比/B→B、傑/J→J、開/K→K、恩/N→N、歐/O→O、丘/Q→Q、艾斯/S→S、提/T→T、優/U→U、微/V→V、'
    + '艾克斯/X→X、賊/Z→Z、伊/E→E、艾夫/F→F、居/G→G、藝去/H→H、愛/I→I。\n'
    + '2b. 若票號的英文字母無法確定，寧可只填數字部分，也不要亂猜字母。\n'
    + '3. 日期：若只講月日（如「八月十五」），推算成從今天起最接近的未來日期；若講民國年（如「115年8月15日」）換算成西元；若講「下個月十號」「月底」也請推算。\n'
    + '4. 金額若同時出現多個數字，取明確標示為金額的那個。\n'
    + '5. 銀行名稱請補成常見全稱或通稱，如「合庫」→「合作金庫」、「一銀」→「第一銀行」、「彰銀」→「彰化商銀」。\n'
    + '6. 沒有提到的欄位填空字串，amount 沒提到就填 null。不要自己編造沒講到的資訊。\n\n'
    + '口述內容：\n' + String(text);

  var payload = {
    model: 'claude-sonnet-5',
    max_tokens: 1000,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  };
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return { error: 'API_' + res.getResponseCode() };
  var data = JSON.parse(res.getContentText());
  var out = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
  var s = out.indexOf('{'), e = out.lastIndexOf('}');
  if (s < 0 || e < 0) return { error: 'PARSE' };
  var p; try { p = JSON.parse(out.substring(s, e + 1)); } catch (err) { return { error: 'PARSE' }; }
  return {
    bank: p.bank || '', branch: p.branch || '',
    accountNumber: p.accountNumber ? String(p.accountNumber) : '',
    checkNumber: p.checkNumber ? String(p.checkNumber) : '',
    dueDate: p.dueDate || '',
    amount: (p.amount === null || p.amount === undefined || p.amount === '') ? '' : Number(String(p.amount).replace(/[^0-9.]/g, '')),
    customerName: p.customerName || ''
  };
}
