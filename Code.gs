/**
 * 程式碼教學展示系統 - Google Apps Script 後端
 * 功能：身分驗證、課程管理、章節管理、程式圖片儲存(Drive)與目錄資料庫(Sheets)
 */

// ==================== 設定區 ====================
// 若需要允許多位老師管理，可在陣列中加入其 Google 帳號 Email
// 若留空，系統會自動以試算表擁有者 (Owner) 的 Email 作為唯一管理員
const ADDITIONAL_TEACHER_EMAILS = [];

// Google 雲端硬碟儲存資料夾名稱 (系統會自動在雲端硬碟建立此資料夾)
const DRIVE_FOLDER_NAME = "程式教學圖片庫_CodeShow";

// 工作表名稱
const SHEET_PROBLEMS = "Problems";
const SHEET_COURSES = "Courses";

// ==================== Web App 入口 (極速外殼直出 + 前端微光非同步同步) ====================
function doGet() {
  var template = HtmlService.createTemplateFromFile("Index");
  template.serverInitialData = "null";
  return template.evaluate()
    .setTitle("程式設計教學展示系統")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ==================== 高速記憶體快取模組 (CacheService) ====================
const CACHE_KEY_COURSES = "codeshow_courses";
const CACHE_KEY_PROBLEMS_PREFIX = "codeshow_prob_";

/**
 * 清除系統快取 (當老師有新增、刪除、排序題目或課程時自動觸發)
 */
function clearSystemCache() {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(CACHE_KEY_COURSES);
    var courses = getCourses();
    var keys = [CACHE_KEY_COURSES];
    for (var i = 0; i < courses.length; i++) {
      keys.push(CACHE_KEY_PROBLEMS_PREFIX + courses[i]);
    }
    cache.removeAll(keys);
  } catch (e) {
    Logger.log("清除快取例外: " + e.message);
  }
}

function getCachedCourses() {
  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(CACHE_KEY_COURSES);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (e) {}

  var courses = getCourses();
  try {
    var cache = CacheService.getScriptCache();
    cache.put(CACHE_KEY_COURSES, JSON.stringify(courses), 600); // 快取 10 分鐘
  } catch (e) {}
  return courses;
}

function getCachedProblems(courseName) {
  if (!courseName) return [];
  var cacheKey = CACHE_KEY_PROBLEMS_PREFIX + courseName;
  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (e) {}

  var problems = getProblemsByCourse(courseName);
  try {
    var serialized = JSON.stringify(problems);
    // CacheService 限制單筆小於 100KB
    if (serialized.length < 95000) {
      var cache = CacheService.getScriptCache();
      cache.put(cacheKey, serialized, 600); // 快取 10 分鐘
    }
  } catch (e) {}
  return problems;
}

// ==================== 整合型極速初始化 API ====================
/**
 * 一次性獲取首頁載入所需全部核心資料：
 * 1. 使用者身分資訊 (是否為老師)
 * 2. 全部課程列表 (優先自高速快取讀取)
 * 3. 當前/第一門課程的全部題目與排序 (優先自高速快取讀取)
 */
function getInitialData(preferredCourse) {
  // 1. 取得使用者身分
  var userInfo = getUserInfo();

  // 2. 取得課程列表 (記憶體快取加速)
  var courses = getCachedCourses();

  // 3. 判定首選或第一門課程
  var currentCourse = preferredCourse && courses.indexOf(preferredCourse) !== -1
    ? preferredCourse
    : (courses.length > 0 ? courses[0] : "");

  // 4. 取得該課程題目清單 (記憶體快取加速)
  var problems = currentCourse ? getCachedProblems(currentCourse) : [];

  return {
    userInfo: userInfo,
    courses: courses,
    currentCourse: currentCourse,
    problems: problems
  };
}

// ==================== 初始化工作表與資料夾 ====================
function initSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. 初始化 Courses 工作表
  var courseSheet = ss.getSheetByName(SHEET_COURSES);
  if (!courseSheet) {
    courseSheet = ss.insertSheet(SHEET_COURSES);
    courseSheet.appendRow(["CourseName", "CreatedAt"]);
    // 預設建立一門範例課程
    courseSheet.appendRow(["Python 基礎程式設計", new Date().toISOString()]);
  }

  // 2. 初始化 Problems 工作表
  var problemSheet = ss.getSheetByName(SHEET_PROBLEMS);
  if (!problemSheet) {
    problemSheet = ss.insertSheet(SHEET_PROBLEMS);
    problemSheet.appendRow(["Course", "Chapter", "ProblemNo", "FileId", "ImageUrl", "Timestamp", "OrderIndex", "Language", "SourceCode"]);
  } else {
    // 檢查第一列是否已有 OrderIndex, Language, SourceCode 欄位，若無則補上
    var headers = problemSheet.getRange(1, 1, 1, Math.max(problemSheet.getLastColumn(), 1)).getValues()[0];
    if (headers.indexOf("OrderIndex") === -1) {
      problemSheet.getRange(1, 7).setValue("OrderIndex");
    }
    if (headers.indexOf("Language") === -1) {
      problemSheet.getRange(1, 8).setValue("Language");
    }
    if (headers.indexOf("SourceCode") === -1) {
      problemSheet.getRange(1, 9).setValue("SourceCode");
    }
    if (headers.indexOf("IsHidden") === -1) {
      problemSheet.getRange(1, 10).setValue("IsHidden");
    }
  }

  // 確保圖片儲存資料夾存在
  getOrCreateFolder(DRIVE_FOLDER_NAME);
}

// 取得或建立雲端資料夾，並設定為任何人可檢視（以便讀取圖片）
function getOrCreateFolder(folderName) {
  var folders = DriveApp.getFoldersByName(folderName);
  var folder;
  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    folder = DriveApp.createFolder(folderName);
  }
  // 設定權限為「知道連結的使用者皆可檢視」
  try {
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log("設定資料夾分享權限注意: " + e.message);
  }
  return folder;
}

// ==================== 身分驗證模組 ====================
/**
 * 取得當前使用者角色與權限
 * 老師本人開啟時，自動判定為 isTeacher: true，免輸入密碼
 */
function getUserInfo() {
  var userEmail = Session.getActiveUser().getEmail().toLowerCase().trim();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ownerEmail = "";
  try {
    ownerEmail = ss.getOwner().getEmail().toLowerCase().trim();
  } catch (e) {
    ownerEmail = "";
  }

  var isTeacher = false;
  if (userEmail && ownerEmail && userEmail === ownerEmail) {
    isTeacher = true;
  } else if (userEmail && ADDITIONAL_TEACHER_EMAILS.map(function(e) { return e.toLowerCase().trim(); }).indexOf(userEmail) !== -1) {
    isTeacher = true;
  }

  return {
    email: userEmail || "訪客/學生",
    ownerEmail: ownerEmail,
    isTeacher: isTeacher
  };
}

function assertTeacher() {
  var user = getUserInfo();
  if (!user.isTeacher) {
    throw new Error("權限不足：僅允許授課老師執行此操作！請確認是否已使用老師 Google 帳號登入。");
  }
}

// ==================== 課程管理 (Course API) ====================
function getCourses() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_COURSES);
  if (!sheet) return [];
  
  var data = sheet.getDataRange().getValues();
  var courses = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      courses.push(data[i][0].toString().trim());
    }
  }
  return courses;
}

function addCourse(courseName) {
  assertTeacher();
  courseName = courseName.trim();
  if (!courseName) throw new Error("課程名稱不能為空");

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_COURSES);
  var courses = getCourses();
  if (courses.indexOf(courseName) !== -1) {
    throw new Error("課程已存在");
  }

  sheet.appendRow([courseName, new Date().toISOString()]);
  clearSystemCache();
  return { success: true, courses: getCourses() };
}

function deleteCourse(courseName) {
  assertTeacher();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_COURSES);
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim() === courseName.trim()) {
      sheet.deleteRow(i + 1);
      break;
    }
  }

  // 同步刪除該課程下的所有題目與圖片
  var probSheet = ss.getSheetByName(SHEET_PROBLEMS);
  if (probSheet) {
    var probData = probSheet.getDataRange().getValues();
    for (var j = probData.length - 1; j >= 1; j--) {
      if (probData[j][0].toString().trim() === courseName.trim()) {
        var fileId = probData[j][3];
        if (fileId) {
          try { DriveApp.getFileById(fileId).setTrashed(true); } catch(e){}
        }
        probSheet.deleteRow(j + 1);
      }
    }
  }

  clearSystemCache();
  return { success: true, courses: getCourses() };
}

// 中文數字轉整數工具 (支援 一、二、三...、十、十一...)
function parseChineseNumber(str) {
  var digits = { '零': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  if (str === '十') return 10;
  if (str.indexOf('十') === 0) return 10 + (digits[str[1]] || 0);
  if (str.indexOf('十') !== -1) {
    var parts = str.split('十');
    return (digits[parts[0]] || 1) * 10 + (digits[parts[1]] || 0);
  }
  return digits[str] !== undefined ? digits[str] : null;
}

// 取得章節排序權重 (自動識別 "二、選擇"、"第3章"、"01" 等序號)
function getChapterWeight(chapterName) {
  if (!chapterName) return 99999;
  var match = chapterName.match(/^(?:第|Chapter\s*)?([0-9一二兩三四五六七八九十]+)(?:[章節、.\s\-_]|$)/i);
  if (match) {
    var num = parseChineseNumber(match[1]);
    if (num !== null && !isNaN(num)) return num;
  }
  return 99999;
}

// ==================== 題目管理 (Problem API) ====================
/**
 * 取得指定課程的所有題目列表
 * 先依章節智慧序號排序，同章節內依上傳時間「由舊到新 (ASC)」排列
 */
function getProblemsByCourse(courseName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  if (!sheet) return [];

  var data = sheet.getDataRange().getValues();
  var problems = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[0].toString().trim() === courseName.trim()) {
      var rawOrder = row[6];
      var orderIndex = (rawOrder !== undefined && rawOrder !== "" && !isNaN(Number(rawOrder))) ? Number(rawOrder) : 999999;
      var language = row[7] ? row[7].toString().trim().toLowerCase() : "python";
      var rawCode = row[8] !== undefined ? row[8].toString() : "";
      var isHidden = (row[9] === true || row[9] === "TRUE" || row[9] === "true");

      problems.push({
        course: row[0].toString().trim(),
        chapter: (row[1] || "未分類章節").toString().trim(),
        problemNo: row[2].toString().trim(),
        fileId: row[3] ? row[3].toString().trim() : "",
        imageUrl: row[4] ? row[4].toString().trim() : "",
        timestamp: row[5] ? new Date(row[5]).getTime() : 0,
        formattedTime: row[5] ? Utilities.formatDate(new Date(row[5]), Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm") : "",
        orderIndex: orderIndex,
        language: language,
        sourceCode: rawCode, // 程式碼原文 (學生逐行執行引擎使用，老師端可一鍵複製)
        isHidden: isHidden
      });
    }
  }

  // 排序：先章節智慧序號；同章節內：先依拖曳排序 orderIndex，若相同則依時間「由舊到新」
  problems.sort(function(a, b) {
    if (a.chapter !== b.chapter) {
      var wA = getChapterWeight(a.chapter);
      var wB = getChapterWeight(b.chapter);
      if (wA !== wB) return wA - wB;
      return a.chapter.localeCompare(b.chapter, "zh-Hant");
    }
    if (a.orderIndex !== b.orderIndex) {
      return a.orderIndex - b.orderIndex;
    }
    return a.timestamp - b.timestamp; // 由舊到新 (舊的在最前)
  });

  return problems;
}

/**
 * 取得指定課程已有的所有章節名稱（提供給上傳下拉清單使用）
 */
function getChaptersByCourse(courseName) {
  var problems = getProblemsByCourse(courseName);
  var chapterSet = {};
  problems.forEach(function(p) {
    if (p.chapter) chapterSet[p.chapter] = true;
  });
  return Object.keys(chapterSet);
}

/**
 * 儲存題目圖片與程式碼（覆蓋或新增）
 * @param {string} course 課程名稱
 * @param {string} chapter 章節名稱
 * @param {string} problemNo 題號
 * @param {string} base64Image 前端 html2canvas 產生的 base64 圖片字串 (data:image/png;base64,...)
 * @param {string} language 程式語言 (python / cpp / c 等)
 * @param {string} sourceCode 原始程式碼字串
 */
function saveProblem(course, chapter, problemNo, base64Image, language, sourceCode) {
  assertTeacher();
  course = (course || "").trim();
  chapter = (chapter || "一般章節").trim();
  problemNo = (problemNo || "").trim();
  language = (language || "python").trim().toLowerCase();
  sourceCode = sourceCode !== undefined && sourceCode !== null ? sourceCode.toString() : "";

  if (!course || !problemNo || !base64Image) {
    throw new Error("課程、題號與圖片內容不可為空！");
  }

  var folder = getOrCreateFolder(DRIVE_FOLDER_NAME);

  // 解析 Base64 圖片資料
  var contentType = "image/png";
  var base64Data = base64Image;
  if (base64Image.indexOf("base64,") !== -1) {
    var parts = base64Image.split("base64,");
    contentType = parts[0].split(":")[1].split(";")[0];
    base64Data = parts[1];
  }
  var decoded = Utilities.base64Decode(base64Data);
  var ext = contentType.indexOf("webp") !== -1 ? ".webp" : (contentType.indexOf("jpeg") !== -1 ? ".jpg" : ".png");
  var fileName = course + "_" + chapter + "_" + problemNo + ext;
  var blob = Utilities.newBlob(decoded, contentType, fileName);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  var data = sheet.getDataRange().getValues();

  var existingRowIndex = -1;
  var oldFileId = "";
  var existingOrder = null;
  var maxOrderInChapter = 0;

  // 檢查同一課程中是否已有相同的「題號」，並計算該章節目前的最大順序編號
  for (var i = 1; i < data.length; i++) {
    var rCourse = data[i][0].toString().trim();
    var rChapter = (data[i][1] || "一般章節").toString().trim();
    var rProbNo = data[i][2].toString().trim();
    var rOrder = data[i][6];

    if (rCourse === course && rChapter === chapter) {
      if (rOrder !== undefined && rOrder !== "" && !isNaN(Number(rOrder))) {
        if (Number(rOrder) > maxOrderInChapter) {
          maxOrderInChapter = Number(rOrder);
        }
      }
    }

    if (rCourse === course && rProbNo === problemNo) {
      existingRowIndex = i + 1; // 試算表行號 (1-indexed)
      oldFileId = data[i][3];
      existingOrder = rOrder;
    }
  }

  // 1. 若已有舊圖，刪除舊圖 (移至垃圾桶)
  if (oldFileId) {
    try {
      DriveApp.getFileById(oldFileId).setTrashed(true);
    } catch (e) {
      Logger.log("清除舊檔案提示: " + e.message);
    }
  }

  // 2. 建立新圖片檔案並設為任何人有連結可檢視
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileId = file.getId();
  
  // 使用 Google Drive 高速縮圖/直接檢視連結格式 (不易被 Google 登入導向阻擋)
  var imageUrl = "https://lh3.googleusercontent.com/d/" + fileId;

  var nowIso = new Date().toISOString();
  var finalOrder = (existingRowIndex > 0 && existingOrder !== null && existingOrder !== "") 
    ? existingOrder 
    : (maxOrderInChapter + 1);

  // 3. 更新或新增試算表資料 (包含 OrderIndex 第 7 欄, Language 第 8 欄, SourceCode 第 9 欄)
  if (existingRowIndex > 0) {
    // 覆蓋取代既有資料
    sheet.getRange(existingRowIndex, 1, 1, 9).setValues([[
      course, chapter, problemNo, fileId, imageUrl, nowIso, finalOrder, language, sourceCode
    ]]);
  } else {
    // 新增一列
    sheet.appendRow([course, chapter, problemNo, fileId, imageUrl, nowIso, finalOrder, language, sourceCode]);
  }

  clearSystemCache();

  return {
    success: true,
    isOverwrite: existingRowIndex > 0,
    problemNo: problemNo,
    imageUrl: imageUrl
  };
}

/**
 * 老師拖曳更新同章節內題目的排序
 * @param {string} course 課程名稱
 * @param {string} chapter 章節名稱
 * @param {Array<string>} orderedProblemNos 依新順序排列的題號陣列 (例如 ['d490', 'm448'])
 */
function updateProblemsOrder(course, chapter, orderedProblemNos) {
  assertTeacher();
  course = (course || "").trim();
  chapter = (chapter || "").trim();
  if (!course || !chapter || !Array.isArray(orderedProblemNos)) {
    throw new Error("更新排序參數無效");
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  if (!sheet) throw new Error("找不到題目工作表");

  var data = sheet.getDataRange().getValues();
  var orderMap = {};
  for (var k = 0; k < orderedProblemNos.length; k++) {
    orderMap[orderedProblemNos[k].toString().trim()] = k + 1;
  }

  // 更新符合 course 與 chapter 的題目順序編號 (第 7 欄 G 欄)
  for (var i = 1; i < data.length; i++) {
    var rCourse = data[i][0].toString().trim();
    var rChapter = (data[i][1] || "未分類章節").toString().trim();
    var rProbNo = data[i][2].toString().trim();

    if (rCourse === course && rChapter === chapter) {
      if (orderMap[rProbNo] !== undefined) {
        sheet.getRange(i + 1, 7).setValue(orderMap[rProbNo]);
      }
    }
  }

  clearSystemCache();
  return { success: true };
}

/**
 * 刪除題目
 */
function deleteProblem(course, problemNo) {
  assertTeacher();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString().trim() === course.trim() && data[i][2].toString().trim() === problemNo.trim()) {
      var fileId = data[i][3];
      if (fileId) {
        try {
          DriveApp.getFileById(fileId).setTrashed(true);
        } catch (e) {}
      }
      sheet.deleteRow(i + 1);
      clearSystemCache();
      return { success: true };
    }
  }

  throw new Error("找不到該題目，無法刪除");
}

/**
 * 刪除整個章節（刪除該章節下所有題目與 Google Drive 圖片）
 * @param {string} course 課程名稱
 * @param {string} chapter 章節名稱
 */
function deleteChapter(course, chapter) {
  assertTeacher();
  course = (course || "").trim();
  chapter = (chapter || "").trim();
  if (!course || !chapter) {
    throw new Error("課程與章節名稱不可為空");
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  if (!sheet) throw new Error("找不到題目工作表");

  var data = sheet.getDataRange().getValues();
  var deletedCount = 0;

  // 由下往上遍歷刪除，避免列索引位移問題
  for (var i = data.length - 1; i >= 1; i--) {
    var rCourse = data[i][0].toString().trim();
    var rChapter = (data[i][1] || "未分類章節").toString().trim();
    var fileId = data[i][3];

    if (rCourse === course && rChapter === chapter) {
      if (fileId) {
        try {
          DriveApp.getFileById(fileId).setTrashed(true);
        } catch (e) {
          Logger.log("清除章節圖片提示: " + e.message);
        }
      }
      sheet.deleteRow(i + 1);
      deletedCount++;
    }
  }

  clearSystemCache();
  return { success: true, deletedCount: deletedCount };
}

/**
 * 老師切換題目的「隱藏 / 顯示」狀態 (多班級進度防偷看)
 * @param {string} course 課程名稱
 * @param {string} problemNo 題號
 * @param {boolean} isHidden 是否隱藏 (true 為隱藏，false 為顯示)
 */
function toggleProblemVisibility(course, problemNo, isHidden) {
  assertTeacher();
  course = (course || "").trim();
  problemNo = (problemNo || "").trim();
  isHidden = Boolean(isHidden);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  if (!sheet) throw new Error("找不到題目資料表");

  // 確保第一列第 10 欄有 IsHidden
  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 10)).getValues()[0];
  if (headers.indexOf("IsHidden") === -1) {
    sheet.getRange(1, 10).setValue("IsHidden");
  }

  var data = sheet.getDataRange().getValues();
  var found = false;

  for (var i = 1; i < data.length; i++) {
    var rCourse = data[i][0] ? data[i][0].toString().trim() : "";
    var rProbNo = data[i][2] ? data[i][2].toString().trim() : "";
    if (rCourse === course && rProbNo === problemNo) {
      sheet.getRange(i + 1, 10).setValue(isHidden);
      found = true;
      break;
    }
  }

  if (!found) {
    throw new Error("找不到題目 " + problemNo + "，無法更新隱藏狀態");
  }

  clearSystemCache();

  return {
    success: true,
    course: course,
    problemNo: problemNo,
    isHidden: isHidden
  };
}

/**
 * 老師下課一鍵批次將指定課程的所有題目設為「顯示」 (解除上課防偷看鎖定)
 * @param {string} course 課程名稱
 */
function batchShowAllProblems(course) {
  assertTeacher();
  course = (course || "").trim();
  if (!course) throw new Error("請指定課程名稱");

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  if (!sheet) throw new Error("找不到題目資料表");

  // 確保第一列第 10 欄有 IsHidden
  var headers = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 10)).getValues()[0];
  if (headers.indexOf("IsHidden") === -1) {
    sheet.getRange(1, 10).setValue("IsHidden");
  }

  var data = sheet.getDataRange().getValues();
  var updatedCount = 0;
  var hasChanges = false;

  for (var i = 1; i < data.length; i++) {
    var rCourse = data[i][0] ? data[i][0].toString().trim() : "";
    var rIsHidden = Boolean(data[i][9]); // 第 10 欄 (0-based index 9)
    if (rCourse === course && rIsHidden) {
      data[i][9] = false;
      updatedCount++;
      hasChanges = true;
    }
  }

  if (hasChanges && data.length > 1) {
    // 單次批次寫回第 10 欄，極致效能
    var colValues = [];
    for (var j = 1; j < data.length; j++) {
      colValues.push([data[j][9]]);
    }
    sheet.getRange(2, 10, colValues.length, 1).setValues(colValues);
  }

  clearSystemCache();

  return {
    success: true,
    course: course,
    updatedCount: updatedCount
  };
}

/**
 * 老師修正題目資訊 (題號 與/或 所屬章節)
 * @param {string} course 課程名稱
 * @param {string} oldProblemNo 原始題號
 * @param {string} newProblemNo 新題號
 * @param {string} newChapter 新章節名稱
 */
function updateProblemInfo(course, oldProblemNo, newProblemNo, newChapter) {
  assertTeacher();
  course = (course || "").trim();
  oldProblemNo = (oldProblemNo || "").trim();
  newProblemNo = (newProblemNo || "").trim();
  newChapter = (newChapter || "").trim();

  if (!course || !oldProblemNo) {
    throw new Error("課程與原始題號不可為空！");
  }
  if (!newProblemNo) {
    throw new Error("新題號不可為空！");
  }
  if (!newChapter) {
    throw new Error("章節名稱不可為空！");
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  if (!sheet) throw new Error("找不到題目資料表");

  var data = sheet.getDataRange().getValues();
  var targetRowIndex = -1;
  var oldChapter = "";
  var targetFileId = "";

  // 檢查同課程下新題號是否已存在 (若有改題號)，並尋找原始題號列
  for (var i = 1; i < data.length; i++) {
    var rCourse = data[i][0] ? data[i][0].toString().trim() : "";
    var rChapter = data[i][1] ? data[i][1].toString().trim() : "";
    var rProbNo = data[i][2] ? data[i][2].toString().trim() : "";

    if (rCourse === course) {
      if (newProblemNo.toLowerCase() !== oldProblemNo.toLowerCase() && rProbNo.toLowerCase() === newProblemNo.toLowerCase()) {
        throw new Error("題號【" + newProblemNo + "】已存在於此課程中，無法重複使用！");
      }
      if (rProbNo === oldProblemNo) {
        targetRowIndex = i + 1;
        oldChapter = rChapter || "未分類章節";
        targetFileId = data[i][3] ? data[i][3].toString().trim() : "";
      }
    }
  }

  if (targetRowIndex === -1) {
    throw new Error("找不到原始題目【" + oldProblemNo + "】，無法更新資訊");
  }

  var isProblemNoChanged = (oldProblemNo !== newProblemNo);
  var isChapterChanged = (oldChapter !== newChapter);

  if (!isProblemNoChanged && !isChapterChanged) {
    return {
      success: true,
      course: course,
      oldProblemNo: oldProblemNo,
      newProblemNo: newProblemNo,
      oldChapter: oldChapter,
      newChapter: newChapter,
      unchanged: true
    };
  }

  // 1. 更新試算表：第 2 欄 (B 欄 Chapter) 與 第 3 欄 (C 欄 ProblemNo)
  if (isChapterChanged) {
    sheet.getRange(targetRowIndex, 2).setValue(newChapter);
  }
  if (isProblemNoChanged) {
    sheet.getRange(targetRowIndex, 3).setValue(newProblemNo);
  }

  // 2. 若 Google Drive 檔案存在，依 course_chapter_problemNo 格式同步重命名檔案
  if (targetFileId) {
    try {
      var file = DriveApp.getFileById(targetFileId);
      var oldName = file.getName();
      var ext = ".png";
      var dotIdx = oldName.lastIndexOf(".");
      if (dotIdx !== -1) {
        ext = oldName.substring(dotIdx);
      }
      var newFileName = course + "_" + newChapter + "_" + newProblemNo + ext;
      file.setName(newFileName);
    } catch (e) {
      Logger.log("重新命名 Drive 檔案提示: " + e.message);
    }
  }

  clearSystemCache();

  return {
    success: true,
    course: course,
    oldProblemNo: oldProblemNo,
    newProblemNo: newProblemNo,
    oldChapter: oldChapter,
    newChapter: newChapter,
    isProblemNoChanged: isProblemNoChanged,
    isChapterChanged: isChapterChanged
  };
}

/**
 * 老師修正題目題號 (相容舊版介面)
 */
function renameProblemNo(course, oldProblemNo, newProblemNo) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_PROBLEMS);
  var currChapter = "";
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] == course && data[i][2] == oldProblemNo) {
        currChapter = data[i][1];
        break;
      }
    }
  }
  return updateProblemInfo(course, oldProblemNo, newProblemNo, currChapter || "未分類章節");
}

// ==================== 遠端 GCC 編譯代理 (Godbolt/Compiler Explorer API) ====================
/**
 * 透過 Compiler Explorer (godbolt.org) 後端進行正統 GCC 13.2 編譯與執行
 * 由 Google Apps Script 伺服器發送，100% 繞過瀏覽器 CORS 限制
 * 回傳格式與原 Wandbox 格式相容：{ status, compiler_error, program_output, program_error }
 * 任何人（包含學生）皆可呼叫，不需 assertTeacher()
 *
 * 效能對比：
 *   Wandbox  : 8~18 秒 (OCI 容器排隊時延)
 *   Godbolt  : 1~3 秒 (CDN 快取 + 分散式節點)
 */
function proxyWandboxCompile(code, stdinInput) {
  var processedCode = code || '';

  // bits/stdc++.h 展開：避免巨型標頭拖慢編譯速度
  if (/^[ \t]*#include\s*[<"]bits\/stdc\+\+\.h[>"]/m.test(processedCode)) {
    var coreHeaders = [
      '#include <iostream>', '#include <vector>', '#include <string>',
      '#include <algorithm>', '#include <cmath>', '#include <map>',
      '#include <set>', '#include <queue>', '#include <stack>',
      '#include <utility>', '#include <bitset>', '#include <numeric>',
      '#include <climits>', '#include <cassert>'
    ].join('\n');
    processedCode = processedCode.replace(/^[ \t]*#include\s*[<"]bits\/stdc\+\+\.h[>"]/m, coreHeaders);
  }

  // Godbolt Compiler Explorer API - 單一請求同步執行 (compile + run)
  var godboltPayload = {
    source: processedCode,
    compiler: 'g132',          // x86-64 gcc 13.2 (穩定版)
    options: {
      userArguments: '-O0 -std=c++17',
      executeParameters: {
        args: [],
        stdin: stdinInput || ''
      },
      compilerOptions: {},
      filters: { execute: true },
      tools: [],
      libraries: []
    },
    lang: 'c++',
    allowStoreCodeDebug: false
  };

  var fetchOptions = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'CodeShowGAS/2.0'
    },
    payload: JSON.stringify(godboltPayload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(
      'https://godbolt.org/api/compiler/g132/compile',
      fetchOptions
    );
    var text = response.getContentText();
    var data;
    try {
      data = JSON.parse(text);
    } catch (jsonErr) {
      return { status: '1', compiler_error: 'Godbolt 回應格式異常：' + text.substring(0, 200), program_error: '', program_output: '' };
    }

    // 解析 Godbolt 回應格式 → 轉換成 Wandbox 相容格式
    // data.stderr        = 編譯錯誤 (array of {text})
    // data.code          = 0 表示編譯成功
    // data.execResult.stdout = 程式輸出 (array of {text})
    // data.execResult.stderr = 程式 stderr/cerr 輸出（逐行除錯追蹤 JSON 寫在此）

    var compilerErrorLines = (data.stderr || []).map(function(l) { return l.text || ''; });
    var compilerError = compilerErrorLines.join('\n').trim();

    // 若編譯失敗 (code != 0)，直接回傳編譯錯誤
    if (data.code !== 0) {
      return {
        status: '1',
        compiler_error: compilerError || '編譯失敗（未知錯誤）',
        program_error: '',
        program_output: ''
      };
    }

    var execResult = data.execResult || {};

    // 程式標準輸出 (stdout)
    var stdoutLines = (execResult.stdout || []).map(function(l) { return l.text || ''; });
    var programOutput = stdoutLines.join('\n');

    // 程式 stderr/cerr 輸出 (逐行除錯追蹤 JSON 寫在此)
    var stderrLines = (execResult.stderr || []).map(function(l) { return l.text || ''; });
    var programError = stderrLines.join('\n');

    // 若執行時發生 runtime error
    var execCode = execResult.code;
    var status = (execCode === 0 || execCode === undefined) ? '0' : String(execCode);

    return {
      status: status,
      compiler_error: '',
      program_output: programOutput,
      program_error: programError,
      program_message: programError
    };

  } catch (e) {
    // Godbolt 無法連線時，改用 Wandbox 作為備援
    return proxyWandboxFallback_(processedCode, stdinInput, e.message);
  }
}

/**
 * Wandbox 備援函式（Godbolt 失效時自動切換）
 */
function proxyWandboxFallback_(processedCode, stdinInput, primaryError) {
  var payload = {
    compiler: 'gcc-13.2.0',
    code: processedCode,
    stdin: stdinInput || '',
    options: 'boost-nothing-gcc-13.2.0'
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'User-Agent': 'CodeShowGAS/1.0' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    var resp = UrlFetchApp.fetch('https://wandbox.org/api/compile.json', options);
    var data = JSON.parse(resp.getContentText());
    var errText = (data.compiler_error || '') + ' ' + (data.program_error || '') + ' ' + (data.program_message || '');
    if (/OCI runtime error|Resource temporarily unavailable/i.test(errText)) {
      payload.compiler = 'gcc-12.3.0';
      payload.options = 'boost-nothing-gcc-12.3.0';
      options.payload = JSON.stringify(payload);
      return JSON.parse(UrlFetchApp.fetch('https://wandbox.org/api/compile.json', options).getContentText());
    }
    return data;
  } catch (e2) {
    return {
      status: '1',
      compiler_error: 'Godbolt 連線異常：' + (primaryError || '') + '；備援 Wandbox 亦失敗：' + (e2.message || String(e2)),
      program_error: '',
      program_output: ''
    };
  }
}
