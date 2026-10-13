#import <Cocoa/Cocoa.h>
int main(int argc, const char *argv[]) { @autoreleasepool {
 NSString *logs=[NSHomeDirectory() stringByAppendingPathComponent:@"Library/Logs/DSSC Layout Portable"];
 [[NSFileManager defaultManager] createDirectoryAtPath:logs withIntermediateDirectories:YES attributes:nil error:nil];
 NSString *errPath=[logs stringByAppendingPathComponent:@"last-launch-error.log"];
 [[NSFileManager defaultManager] createFileAtPath:errPath contents:nil attributes:nil];
 NSFileHandle *err=[NSFileHandle fileHandleForWritingAtPath:errPath];
 NSTask *task=[[NSTask alloc] init]; task.executableURL=[NSURL fileURLWithPath:[[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"runtime/node"]];
 task.arguments=@[[[NSBundle mainBundle] pathForResource:@"launcher" ofType:@"mjs"]];
 task.standardOutput=err; task.standardError=err;
 NSError *failure=nil; BOOL launched=[task launchAndReturnError:&failure];
 if(launched) [task waitUntilExit];
 [err closeFile];
 if(!launched || task.terminationStatus!=0){
  [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory]; [NSApp activateIgnoringOtherApps:YES];
  NSAlert *alert=[[NSAlert alloc] init]; alert.messageText=@"DSSC Layout Portable 無法啟動";
  NSString *detail=launched?[NSString stringWithContentsOfFile:errPath encoding:NSUTF8StringEncoding error:nil]:[failure localizedDescription];
  alert.informativeText=[NSString stringWithFormat:@"%@\n\n日誌：%@",detail?:@"未知錯誤",logs]; [alert addButtonWithTitle:@"好"]; [alert runModal]; return 1;
 } return 0;
}}
