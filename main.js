const { app, BrowserWindow, ipcMain, session } = require("electron");
const { Binary } = require("mongodb");
const { MongoClient } = require("mongodb");
require("electron-reload")(__dirname);
const fs = require("fs");
const { ObjectId } = require("mongodb");
const crypto = require("crypto");
const { dialog } = require("electron");
const url = "mongodb://127.0.0.1:27017";
const dbName = "local";
const archiver = require("archiver");
const path = require("path");

function generateHashSID() {
  // Create a random set of bytes
  const randomBytes = crypto.randomBytes(16);

  // Hash those bytes using MD5
  const hash = crypto.createHash("md5").update(randomBytes).digest("hex");

  return hash;
}

let db;
let mainWindow;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Text2Img Info Storager",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      contentSecurityPolicy:
        "default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'",
    },
  });

  mainWindow.loadFile("submit.html");
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.setTitle("Text2Img Info Storager");
  });

  //打開程式後自動開啟Devtools
  // mainWindow.webContents.openDevTools();
};

//連接到MongoDB，並初始化程式
const initApp = async () => {
  try {
    const client = await MongoClient.connect(url, { useUnifiedTopology: true });
    console.log("Connected successfully to MongoDB server");
    db = client.db(dbName);

    createWindow();
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    app.quit(); // 如果不能連接到MongoDB，終止應用程序
    console.log("Quit app");
  }
};

app.on("ready", initApp);

//切換頁面
ipcMain.on("navigate", (event, page) => {
  mainWindow.loadFile(page);
});

//將資料處理後寫入資料庫
ipcMain.on("data-from-renderer", async (event, data) => {
  console.log("Received data from renderer:", data);

  data.sid = generateHashSID();
  console.log("Generated SID:", data.sid);

  if (!data.txt2img) {
    console.error("txt2img file not provided!");
    event.reply("data-insertion-failure", "true");
    return 1;
  }

  try {
    console.log("Starting file processing..."); // Debug line

    // For txt2img
    const txt2imgBuffer = fs.readFileSync(data.txt2img);
    data.txt2img = txt2imgBuffer;

    // For preprocessorPreview
    if (data.preprocessorPreview) {
      const preprocessorPreviewBuffer = fs.readFileSync(
        data.preprocessorPreview
      );
      data.preprocessorPreview = preprocessorPreviewBuffer;
    }

    // For JSONFileForPose
    if (data.JSONFileForPose) {
      const jsonData = JSON.parse(
        fs.readFileSync(data.JSONFileForPose, "utf8")
      );
      data.JSONFileForPose = jsonData;
    }

    if (data.jsonPath) {
      const jsonData = JSON.parse(fs.readFileSync(data.jsonPath, "utf8"));
      data.json = jsonData;
      delete data.jsonPath;
    }

    if (data.preprocessorPreviewPath) {
      const preprocessorPreviewBuffer = fs.readFileSync(
        data.preprocessorPreviewPath
      );
      data.preprocessorPreview = preprocessorPreviewBuffer;
      delete data.preprocessorPreviewPath;
    }

    console.log("File processing completed successfully."); // Debug line

    const collection = db.collection("text2img_generated_info");

    console.log("About to insert into MongoDB..."); // Debug line

    await collection.insertOne(data);

    console.log("Data inserted to MongoDB");
    event.reply("data-insertion-success", "true");
  } catch (err) {
    console.error("Caught an error:", err.message); // Debug line
    console.error("Error processing files or interacting with MongoDB:", err);
    event.reply("data-insertion-failure", "true");
  }
});

//儲存Presets資料到資料庫
ipcMain.on("store-preset", async (event, data) => {
  const collection = db.collection("preset");
  try {
    await collection.insertOne(data);
    event.reply("preset-stored-successfully", true);
  } catch (error) {
    console.error("Error storing preset:", error);
    event.reply("preset-stored-successfully", false);
  }
});

//讀取Presets資料
ipcMain.on("load-preset", async (event, presetName) => {
  const collection = db.collection("preset");
  try {
    const presetData = await collection.findOne({ name: presetName });
    event.reply("load-preset-data", presetData);
  } catch (error) {
    console.error("Error loading preset:", error);
  }
});

//抓取Presets名稱
ipcMain.on("fetch-presets", async (event) => {
  const collection = db.collection("preset");
  try {
    const presets = await collection.find({}).toArray();
    const presetNames = presets.map((preset) => preset.name);
    event.reply("send-preset-names", presetNames);
  } catch (error) {
    console.error("Error fetching presets:", error);
  }
});

//抓取圖片二進制數據轉換為圖片並排序
ipcMain.on("fetch-images", async (event, sortOrder) => {
  console.log(
    "fetch-images event received in main process with sortOrder:",
    sortOrder
  );
  const collection = db.collection("text2img_generated_info");

  const sortOption =
    sortOrder === "newest" ? { timestamp: -1 } : { timestamp: 1 };

  try {
    console.log("Sort Option:", sortOption);
    const images = await collection.find({}).sort(sortOption).toArray();
    event.reply("send-images", images);
  } catch (error) {
    console.error("Error fetching images from MongoDB:", error);
  }
});

//以指定欄位搜尋圖片
ipcMain.on("search-images", async (event, { field, keyword }) => {
  console.log(`Searching images by ${field} for keyword: ${keyword}`);
  const collection = db.collection("text2img_generated_info");

  let query = {};

  // If field is 'posPrompts', we want to check if the keyword exists in the array
  if (field === "posPrompts") {
    query[field] = keyword;
  } else {
    // For string fields, use a regex match for flexibility
    query[field] = new RegExp(keyword, "i");
  }

  try {
    const images = await collection.find(query).toArray();
    event.reply("send-images", images);
  } catch (error) {
    console.error("Error searching images from MongoDB:", error);
    event.reply("send-images", []);
  }
});

ipcMain.on("download-all-images", async (event) => {
  console.log("Download all images event received in main process");

  // Prompt the user to choose the download location
  const dialogResult = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `text2img_images_${getCurrentDate()}.zip`,
    filters: [{ name: "Zip Files", extensions: ["zip"] }],
  });

  if (dialogResult.canceled) {
    console.log("User canceled the download.");
    return;
  }

  const outputDir = dialogResult.filePath;
  const collection = db.collection("text2img_generated_info");

  try {
    const images = await collection.find({}).toArray();
    downloadAllImages(images, outputDir);
  } catch (error) {
    console.error("Error fetching images from MongoDB:", error);
  }
});

function downloadAllImages(images, outputDir) {
  const output = fs.createWriteStream(outputDir);
  const archive = archiver("zip");

  output.on("close", () => {
    console.log("All images have been added to the zip file.");
    dialog.showMessageBox({
      type: "info",
      title: "Download Complete",
      message: "All images have been downloaded as a zip file.",
      buttons: ["OK"],
    });
  });

  archive.pipe(output);

  images.forEach((image, index) => {
    if (image.txt2img) {
      const imageBuffer = Buffer.from(image.txt2img.buffer);
      archive.append(imageBuffer, { name: `image_${index}.jpg` });
    }
  });

  archive.finalize();
}

function getCurrentDate() {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

//儲存圖片ID至全域變數
ipcMain.on("set-current-sid", (event, sid) => {
  global.currentSid = sid;
});

//點擊圖片時，載入圖片詳細資訊頁面
ipcMain.on("load-image-details", async (event, sid) => {
  const collection = db.collection("text2img_generated_info");
  const imageDetails = await collection.findOne({ sid: sid });

  if (!imageDetails) {
    console.error(`No details found for sid: ${sid} in the database.`);
    return;
  }
  global.currentSid = imageDetails.sid;

  console.log("Fetching details for sid:", sid);
  console.log("Fetched imageDetails:", imageDetails);

  mainWindow.loadFile("image_details.html", {
    query: { sid: sid },
  });

  // Send the image details after the page has finished loading
  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow.webContents.send("send-image-details", imageDetails);
  });
});

//重新抓取詳細資訊
ipcMain.on("re-fetch-details", async (event, sid) => {
  console.log("Received re-fetch request for sid:", sid);
  const collection = db.collection("text2img_generated_info");
  const imageDetails = await collection.findOne({ sid: sid });

  if (!imageDetails) {
    console.error(`No details found for sid: ${sid} in the database.`);
    return;
  }

  console.log("Re-fetching details for sid:", sid);

  // Send the image details back to the renderer
  event.reply("send-image-details", imageDetails);
});

//在Preview頁面刪除該筆圖片資料
ipcMain.on("delete-image", async (event, sid) => {
  const collection = db.collection("text2img_generated_info");
  try {
    const result = await collection.deleteOne({ sid: sid });
    if (result.deletedCount === 1) {
      event.reply("image-deletion-result", "success");
    } else {
      event.reply("image-deletion-result", "fail");
    }
  } catch (error) {
    console.error("Error deleting image from MongoDB:", error);
    event.reply("image-deletion-result", "fail");
  }
});

//更新圖片資料
ipcMain.on("update-data", async (event, dataToUpdate) => {
  console.log(dataToUpdate); // Debug line

  try {
    const collection = db.collection("text2img_generated_info");
    const query = { sid: dataToUpdate.sid };

    // Remove the sid from dataToUpdate as it's used for the query, not the update.
    delete dataToUpdate.sid;

    if (dataToUpdate.txt2imgBuffer) {
      const base64Image = dataToUpdate.txt2imgBuffer.toString("base64");
      dataToUpdate.txt2img = Binary.createFromBase64(base64Image);
      delete dataToUpdate.txt2imgBuffer;
    }

    if (dataToUpdate.preprocessorPreviewBuffer) {
      const base64Image =
        dataToUpdate.preprocessorPreviewBuffer.toString("base64");
      dataToUpdate.preprocessorPreview = Binary.createFromBase64(base64Image);
      delete dataToUpdate.preprocessorPreviewBuffer; // Delete buffer from object
    }

    let updateDoc = { $set: dataToUpdate };

    // Remove unwanted properties from the updateDoc
    delete updateDoc.$set[""];
    // delete updateDoc.$set["JSONFileForPose"];
    delete updateDoc.$set["timestamp"];

    console.log(updateDoc); // Debug line

    if (Object.keys(updateDoc.$set).length === 0) {
      console.error("No valid fields to update.");
      return;
    }

    // Then proceed with the update
    const result = await collection.updateOne(query, updateDoc);

    if (result.modifiedCount === 1) {
      event.reply("update-data-response", "Data updated successfully");
    } else {
      event.reply("update-data-response", "No data was updated");
    }
  } catch (error) {
    console.error("Error updating data:", error);
    event.reply("update-data-response", "Error updating data");
  }
});
