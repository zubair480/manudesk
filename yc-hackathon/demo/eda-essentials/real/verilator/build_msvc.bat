@echo off
rem Compile the Verilator-generated C++ model with MSVC (no make on this machine).
rem Equivalent of the "make -C obj_dir -f Vpwm_led.mk" step that --build runs.
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
set VR=C:\fpga\oss-cad-suite\share\verilator
cd /d "%~dp0"
cl /nologo /std:c++17 /O2 /EHsc /MT /DNDEBUG /DVM_TRACE=0 /DVL_IGNORE_UNKNOWN_ARCH ^
  /I obj_dir /I "%VR%\include" /I "%VR%\include\vltstd" ^
  sim_main.cpp ^
  obj_dir\Vpwm_led.cpp obj_dir\Vpwm_led___024root__0.cpp ^
  obj_dir\Vpwm_led___024root__Slow.cpp obj_dir\Vpwm_led___024root__0__Slow.cpp ^
  obj_dir\Vpwm_led__Syms__Slow.cpp ^
  "%VR%\include\verilated.cpp" "%VR%\include\verilated_threads.cpp" ^
  /Fo:obj_dir\ /Fe:obj_dir\Vpwm_led.exe
echo cl exit %ERRORLEVEL%
