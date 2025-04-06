console.log("Starting Biomes application...");

const fs = require("fs");
const path = require("path");

// Helper function to list directory contents
function listDirectory(dir) {
  try {
    console.log(`Contents of ${dir}:`);
    const files = fs.readdirSync(dir);
    files.forEach(file => {
      const stats = fs.statSync(path.join(dir, file));
      console.log(`- ${file} (${stats.isDirectory() ? 'directory' : 'file'})`);
    });
    return files;
  } catch (err) {
    console.error(`Error listing ${dir}:`, err.message);
    return [];
  }
}

// List root directory contents to debug
listDirectory("/app");

try {
  // Try different possible entry point locations
  if (fs.existsSync("/app/server.js")) {
    console.log("Found server.js in root directory, starting...");
    require("/app/server.js");
  } else if (fs.existsSync("/app/.next/standalone/server.js")) {
    console.log("Found server.js in Next.js standalone directory, starting...");
    require("/app/.next/standalone/server.js");
  } else if (fs.existsSync("/app/dist/server.js")) {
    console.log("Found server.js in dist directory, starting...");
    require("/app/dist/server.js");
  } else {
    // Search for any server.js file
    console.log("Searching for server.js file...");
    
    // Check if .next directory exists
    if (fs.existsSync("/app/.next")) {
      listDirectory("/app/.next");
    }
    
    console.error("No server.js entry point found!");
    console.log("Looking for any .js files in root directory:");
    
    const files = listDirectory("/app");
    const jsFiles = files.filter(file => file.endsWith('.js'));
    
    if (jsFiles.length > 0) {
      console.log("Found JS files, trying first one:", jsFiles[0]);
      require(path.join("/app", jsFiles[0]));
    } else {
      console.error("No JavaScript files found in the root directory");
      process.exit(1);
    }
  }
} catch (error) {
  console.error("Error starting server:", error);
  process.exit(1);
}
