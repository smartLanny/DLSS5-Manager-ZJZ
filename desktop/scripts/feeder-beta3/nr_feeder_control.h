#pragma once
#include <windows.h>
#include <string>
#include <cstdio>
#include <cstdlib>
#include <cctype>

// The provider switch owns one plain key; unrelated Feeder options are retained.
struct NrFeederControl {
    bool enabled=true,loaded=false;unsigned long long generation=1,next_read=0;
    std::wstring file;std::string error;
    static bool Read(const std::wstring &path,std::string &text) {
        DWORD attrs=GetFileAttributesW(path.c_str());
        if(attrs==INVALID_FILE_ATTRIBUTES&&GetLastError()==ERROR_FILE_NOT_FOUND){text.clear();return true;}
        if(attrs==INVALID_FILE_ATTRIBUTES||(attrs&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)))return false;
        FILE *input=nullptr;_wfopen_s(&input,path.c_str(),L"rb");if(!input)return false;
        char bytes[32769]{};const size_t count=fread(bytes,1,sizeof(bytes),input);const bool ok=!ferror(input)&&count<sizeof(bytes);fclose(input);
        if(!ok||memchr(bytes,0,count))return false;text.assign(bytes,count);return true;
    }
    static bool EnabledLine(const std::string &line,size_t &equals) {
        equals=line.find('=');if(equals==std::string::npos)return false;
        size_t begin=line.compare(0,3,"\xEF\xBB\xBF")==0?3:0,end=equals;
        while(begin<end&&std::isspace(static_cast<unsigned char>(line[begin])))++begin;
        while(end>begin&&std::isspace(static_cast<unsigned char>(line[end-1])))--end;
        return line.substr(begin,end-begin)=="enabled";
    }
    static bool Parse(const std::string &text,bool &value) {
        value=true;size_t start=0;
        while(start<text.size()){
            size_t end=text.find('\n',start);if(end==std::string::npos)end=text.size();std::string line=text.substr(start,end-start);size_t equals=0;
            if(EnabledLine(line,equals)){
                const char *input=line.c_str()+equals+1;char *tail=nullptr;long parsed=strtol(input,&tail,10);
                if(tail==input||(parsed!=0&&parsed!=1))return false;
                while(*tail&&std::isspace(static_cast<unsigned char>(*tail)))++tail;
                if(*tail&&*tail!=';'&&*tail!='#')return false;value=parsed!=0;
            }
            start=end+1;
        }
        return true;
    }
    void Set(bool value){if(!loaded||enabled!=value){enabled=value;loaded=true;++generation;}}
    void Refresh(bool force=false){const auto now=GetTickCount64();if(!force&&loaded&&now<next_read)return;next_read=now+250;
        std::string text;bool value=true;if(!Read(file,text)||!Parse(text,value)){error="无法读取 provider enabled 配置；已保留原帧。";Set(false);return;}
        error.clear();Set(value);
    }
    bool Save(bool value){std::string text;if(!Read(file,text)){error="配置不可安全读取，未覆盖原文件。";return false;}
        std::string output;bool found=false;size_t start=0;
        while(start<text.size()){
            size_t end=text.find('\n',start);const bool newline=end!=std::string::npos;if(!newline)end=text.size();
            const std::string line=text.substr(start,end-start);size_t equals=0;
            if(EnabledLine(line,equals)){output+=line.substr(0,equals+1)+(value?"1":"0");if(!line.empty()&&line.back()=='\r')output+='\r';found=true;}else output+=line;
            if(newline)output+='\n';start=end+1;
        }
        if(!found){if(!output.empty()&&output.back()!='\n')output+='\n';output+=value?"enabled=1\n":"enabled=0\n";}
        wchar_t suffix[96]{};swprintf_s(suffix,L".nr-switch.%lu.%llu.tmp",GetCurrentProcessId(),GetTickCount64());const std::wstring temporary=file+suffix;
        HANDLE handle=CreateFileW(temporary.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);if(handle==INVALID_HANDLE_VALUE){error="无法保存 NR 开关，原配置未修改。";return false;}
        DWORD written=0;bool ok=WriteFile(handle,output.data(),static_cast<DWORD>(output.size()),&written,nullptr)&&written==output.size()&&FlushFileBuffers(handle);CloseHandle(handle);
        if(ok)ok=MoveFileExW(temporary.c_str(),file.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=FALSE;
        if(!ok){DeleteFileW(temporary.c_str());error="无法保存 NR 开关，原配置未修改。";return false;}
        error.clear();Set(value);next_read=GetTickCount64()+250;return true;
    }
};
