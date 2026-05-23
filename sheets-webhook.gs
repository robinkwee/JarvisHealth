// Google Apps Script — paste this in your Sheet's script editor
// Extensions > Apps Script > paste > Save > Deploy > New Deployment > Web App
// Set "Execute as: Me" and "Who has access: Anyone"
// Copy the URL and set SHEETS_WEBHOOK env var in the bot

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName("Meals") || ss.getSheets()[0];

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["user_id", "date", "time", "description", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g", "photo_msg_id"]);
      sheet.getRange(1, 1, 1, 10).setFontWeight("bold");
    }

    sheet.appendRow([
      data.user_id || "",
      data.date, data.time, data.description,
      data.calories, data.protein_g, data.carbs_g,
      data.fat_g, data.fiber_g, data.photo_msg_id || "",
    ]);

    updateDailyTotal(data.date, data.user_id);

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === "settings") return getSettingsResponse();
  if (action === "daily") return getDailyTotalResponse(e.parameter.date, e.parameter.user_id);
  return ContentService.createTextOutput("Calorie Tracker webhook active");
}

function toDateStr(val) {
  if (val instanceof Date) return Utilities.formatDate(val, Session.getScriptTimeZone(), "yyyy-MM-dd");
  return String(val).trim();
}

function getDailyTotalResponse(date, user_id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("Meals") || ss.getSheets()[0];
  const logData = logSheet.getDataRange().getValues();
  if (logData.length < 2) {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, totals: null }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const headers = logData[0].map(function(h) { return String(h).trim(); });
  const userCol = headers.indexOf("user_id");
  const dateCol = headers.indexOf("date");
  const calCol  = headers.indexOf("calories");
  const protCol = headers.indexOf("protein_g");
  const carbCol = headers.indexOf("carbs_g");
  const fatCol  = headers.indexOf("fat_g");
  const fibCol  = headers.indexOf("fiber_g");

  var totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, meals: 0 };
  for (var i = 1; i < logData.length; i++) {
    var rowDate = toDateStr(logData[i][dateCol]);
    var rowUser = String(logData[i][userCol]).trim();

    if (rowDate === date && (user_id === undefined || rowUser === String(user_id))) {
      totals.calories  += parseFloat(logData[i][calCol])  || 0;
      totals.protein_g += parseFloat(logData[i][protCol]) || 0;
      totals.carbs_g   += parseFloat(logData[i][carbCol]) || 0;
      totals.fat_g     += parseFloat(logData[i][fatCol])  || 0;
      totals.fiber_g   += parseFloat(logData[i][fibCol])  || 0;
      totals.meals++;
    }
  }

  function r1(n) { return Math.round(n * 10) / 10; }
  totals.calories  = r1(totals.calories);
  totals.protein_g = r1(totals.protein_g);
  totals.carbs_g   = r1(totals.carbs_g);
  totals.fat_g     = r1(totals.fat_g);
  totals.fiber_g   = r1(totals.fiber_g);

  return ContentService.createTextOutput(JSON.stringify({ ok: true, totals: totals }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSettingsResponse() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Register");
  if (!sheet || sheet.getLastRow() < 2) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Register sheet not found or empty" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values  = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  const settings = {};
  headers.forEach(function(h, i) {
    if (h) settings[String(h).trim()] = values[i];
  });
  return ContentService.createTextOutput(JSON.stringify({ ok: true, settings: settings }))
    .setMimeType(ContentService.MimeType.JSON);
}

function updateDailyTotal(date, user_id) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet  = ss.getSheetByName("Meals") || ss.getSheets()[0];
  const dailySheet = ss.getSheetByName("Daily Total");
  if (!dailySheet) return;

  const logData = logSheet.getDataRange().getValues();
  if (logData.length < 2) return;

  const headers = logData[0].map(function(h) { return String(h).trim(); });
  const userCol = headers.indexOf("user_id");
  const dateCol = headers.indexOf("date");
  const calCol  = headers.indexOf("calories");
  const protCol = headers.indexOf("protein_g");
  const carbCol = headers.indexOf("carbs_g");
  const fatCol  = headers.indexOf("fat_g");
  const fibCol  = headers.indexOf("fiber_g");

  var totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 };
  for (var i = 1; i < logData.length; i++) {
    var rowDate = toDateStr(logData[i][dateCol]);
    var rowUser = String(logData[i][userCol]).trim();

    if (rowDate === date && (user_id === undefined || rowUser === String(user_id))) {
      totals.calories  += parseFloat(logData[i][calCol])  || 0;
      totals.protein_g += parseFloat(logData[i][protCol]) || 0;
      totals.carbs_g   += parseFloat(logData[i][carbCol]) || 0;
      totals.fat_g     += parseFloat(logData[i][fatCol])  || 0;
      totals.fiber_g   += parseFloat(logData[i][fibCol])  || 0;
    }
  }

  function r1(n) { return Math.round(n * 10) / 10; }
  var row = [date, String(user_id), r1(totals.calories), r1(totals.protein_g), r1(totals.carbs_g), r1(totals.fat_g), r1(totals.fiber_g)];

  if (dailySheet.getLastRow() === 0) {
    dailySheet.appendRow(["date", "user_id", "calories", "protein_g", "carbs_g", "fat_g", "fiber_g"]);
    dailySheet.getRange(1, 1, 1, 7).setFontWeight("bold");
  }

  const dailyData = dailySheet.getDataRange().getValues();
  const dHeaders  = dailyData[0].map(function(h) { return String(h).trim(); });
  const dDateCol  = dHeaders.indexOf("date");
  const dUserCol  = dHeaders.indexOf("user_id");

  for (var j = 1; j < dailyData.length; j++) {
    var dRowDate = toDateStr(dailyData[j][dDateCol]);
    var dRowUser = String(dailyData[j][dUserCol]).trim();

    if (dRowDate === date && dRowUser === String(user_id)) {
      dailySheet.getRange(j + 1, 1, 1, 7).setValues([row]);
      return;
    }
  }
  dailySheet.appendRow(row);
}
