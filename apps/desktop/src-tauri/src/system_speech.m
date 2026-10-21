#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

typedef void (*PierSpeechCallback)(void *, const char *, const char *);

// All jobs and terminal callbacks are confined to the main queue. Rust owns the
// callback context and audio file until exactly one terminal callback consumes it.
@interface PierSpeechJob : NSObject
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@property(nonatomic, strong) SFSpeechRecognitionTask *task;
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic) PierSpeechCallback callback;
@property(nonatomic) void *context;
@end
@implementation PierSpeechJob
@end

static NSMutableDictionary<NSString *, PierSpeechJob *> *jobs;

static void finish(PierSpeechJob *job, NSString *text, NSString *error) {
    if (!job.callback) return;
    PierSpeechCallback callback = job.callback;
    job.callback = NULL;
    [jobs removeObjectForKey:job.identifier];
    [job.task cancel];
    job.task = nil;
    callback(job.context, text.UTF8String, error.UTF8String);
}

void pier_speech_authorize(void *context, PierSpeechCallback callback) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (@available(macOS 10.15, *)) {
            [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
                NSString *error = nil;
                if (status == SFSpeechRecognizerAuthorizationStatusDenied) {
                    error = @"语音识别权限被拒绝，请在系统设置 → 隐私与安全性 → 语音识别中允许 Pier";
                } else if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                    error = @"系统语音识别不可用或受到限制，请检查 macOS 设置或选择自定义语音服务";
                }
                callback(context, NULL, error.UTF8String);
            }];
        } else {
            callback(context, NULL, "系统语音识别需要 macOS 10.15 或更新版本，请升级系统或选择自定义语音服务");
        }
    });
}

void pier_speech_transcribe(const char *identifier, const char *path, const char *language,
                           void *context, PierSpeechCallback callback) {
    // Copy borrowed Rust strings before returning across FFI.
    NSString *jobID = [NSString stringWithUTF8String:identifier];
    NSString *audioPath = [NSString stringWithUTF8String:path];
    NSString *localeID = [NSString stringWithUTF8String:language];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (@available(macOS 10.15, *)) {
            if (!jobs) jobs = [NSMutableDictionary dictionary];
            if (jobs.count) {
                callback(context, NULL, "已有系统语音识别正在进行，请稍后重试");
                return;
            }
            if ([SFSpeechRecognizer authorizationStatus] != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                callback(context, NULL, "请在系统设置 → 隐私与安全性 → 语音识别中允许 Pier");
                return;
            }
            NSString *chosenLocaleID = localeID;
            if (!chosenLocaleID.length) {
                NSMutableArray<NSString *> *supported = [NSMutableArray array];
                for (NSLocale *locale in SFSpeechRecognizer.supportedLocales) {
                    [supported addObject:locale.localeIdentifier];
                }
                // Follow language preferences rather than the date/number formatting region.
                chosenLocaleID = [NSBundle preferredLocalizationsFromArray:supported
                    forPreferences:NSLocale.preferredLanguages].firstObject;
            }
            NSLocale *locale = chosenLocaleID.length ? [NSLocale localeWithLocaleIdentifier:chosenLocaleID] : NSLocale.currentLocale;
            SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];
            if (!recognizer || !recognizer.available) {
                callback(context, NULL, "当前语言的系统语音识别不可用，请检查网络、识别语言或切换自定义语音服务");
                return;
            }
            SFSpeechURLRecognitionRequest *request = [[SFSpeechURLRecognitionRequest alloc]
                initWithURL:[NSURL fileURLWithPath:audioPath]];
            request.shouldReportPartialResults = NO;
            request.taskHint = SFSpeechRecognitionTaskHintDictation;
            request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition;
            PierSpeechJob *job = [PierSpeechJob new];
            job.identifier = jobID;
            job.recognizer = recognizer;
            job.context = context;
            job.callback = callback;
            jobs[jobID] = job;
            job.task = [recognizer recognitionTaskWithRequest:request
                resultHandler:^(SFSpeechRecognitionResult *result, NSError *error) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (result.isFinal) {
                            finish(job, result.bestTranscription.formattedString, nil);
                        } else if (error) {
                            finish(job, nil, @"系统语音识别失败，请检查网络和识别语言后重试，或切换自定义语音服务");
                        }
                    });
                }];
            // Also bounds lifetime when the page reloads or the speech service stops responding.
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 65 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                finish(job, nil, @"系统语音识别超时，请重试");
            });
        } else {
            callback(context, NULL, "系统语音识别需要 macOS 10.15 或更新版本");
        }
    });
}

void pier_speech_cancel(const char *identifier) {
    NSString *jobID = [NSString stringWithUTF8String:identifier];
    dispatch_async(dispatch_get_main_queue(), ^{
        PierSpeechJob *job = jobs[jobID];
        if (job) finish(job, nil, @"语音输入已取消");
    });
}
