---
title: AXDR-L X7 速度环 FOC 移植与 300 rpm 调参复盘
date: 2026-09-15 13:00:00
updated: 2026-09-15 13:00:00
categories:
  - 课程设计
tags:
  - AXDR
  - X7
  - FOC
  - PID
  - STM32G474
  - M2006
  - MT6816
  - Simulink
  - 电机控制
permalink: articles/axdr-x7-speedloop-pid-current-loop/
comments: false
---
> 本文记录一次从 X7/Simulink 速度环仿真迁移到 AXDR-L / AxDrive-L 实物平台的完整过程。重点不是“电机能转”，而是说明一个课程设计里的仿真文件，如何一步步被拆成参数脚本、控制器验证模型、可编译 C 工程、20 kHz 电流环、1 kHz 速度环、编码器电角度闭环、SVPWM 输出、保护状态机、VOFA 遥测和自动化验证脚本。

<!-- more -->

## 从仿真到实机的整体路线

一开始的输入不是一个能直接刷进板子的工程，而是一组 X7 FOC 学习模型。`0.AxDr_simulink` 目录里既有坐标变换、SVPWM、V/f、I/f、电流环、速度环、位置环，也有电阻/电感/磁链/惯量辨识、ESMO、PLL、弱磁、RLS、EKF 等后续模型。真正用于本次课程设计主线的是 `x7_foc_speedloop.slx` 及它的 R2025b 兼容版本，目标是把速度环控制思路迁到 AXDR-L 的 STM32G474 + M2006 + MT6816 实物平台上。

整个开发过程可以按下面这条链理解：

```text
Simulink FOC 学习模型
  -> foc_para.m 提取控制参数、物理参数和采样频率
  -> R2025b 兼容处理：SPS/Simscape 块迁移和 fixed-step 设置
  -> 无 SPS 数值脚本：先验证速度环、限流、负载扰动是否合理
  -> controller-only 模型：只保留 ref/speed -> Iq 的控制器接口
  -> C 工程安全演示：sim2board_demo 在板端跑同一套离散算法但关闭相 PWM
  -> 硬件遥测模式：确认 ADC、VBUS、MT6816、R_EN、TIM1 状态都可观测
  -> 开环低功率转动：验证相序、角度方向、PWM/SVPWM 输出路径
  -> 编码器电角度校准：建立 theta_e 与 MT6816 的 offset/dir 关系
  -> 速度环闭环：1 kHz 外环输出 Iq_ref，20 kHz 内环执行 Id/Iq FOC
  -> 自动化脚本验收：固定命令、固定采样窗口、固定安全阈值重复测试
```

这个路线的核心取舍是：不把 Simulink 自动生成代码当成最终固件，而是把 Simulink 当作“控制结构和参数来源”。真正上板时，需要重写和补齐仿真里没有的部分：ADC 触发、PWM 互补输出、R_EN 使能、编码器 SPI、故障停机、串口命令、LCD 显示和测试脚本。

## 仿真文件族与角色分工

本次不是只打开一个 `.slx`，而是先把仿真目录里的模型按用途分类。这样做的好处是，后续文章和代码都能说明“哪个模型贡献了控制算法，哪个脚本只是为兼容或报告服务”。

| 文件 / 目录 | 角色 | 在移植中的作用 |
| --- | --- | --- |
| `x1_foc_transform.slx` | 坐标变换基础模型 | 对应固件里的 Clarke / Park / inverse Park |
| `x2_foc_svpwm.slx` | SVPWM 模型 | 对应 `foc_calc.c` 的 `svm()` 和 TIM1 CCR 更新 |
| `x3_foc_vf.slx` | V/f 开环模型 | 用作实机最早的低功率开环转动思路 |
| `x5_foc_if.slx` | I/f 启动模型 | 为后续无感和电角度拖动提供参考 |
| `x6_foc_currentloop.slx` | Id/Iq 电流环模型 | 提供 `Kp=L*wc`、`Ki=R*wc` 的电流环整定主线 |
| `x7_foc_speedloop.slx` | 速度环主模型 | 本文主线，速度误差经 PID 输出转矩/电流请求 |
| `x7_foc_speedloop_R2025b_latched.slx` | R2025b 兼容版本 | 保留速度环主线，解决新版 MATLAB 兼容问题 |
| `x7_foc_speedloop_R2025b_codegen_fixedstep.slx` | fixed-step 版本 | 用于代码生成检查，强调离散固定步长 |
| `converted_x7/x7_foc_speedloop_simscape_patched.slx` | Simscape 转换模型 | 验证原 SPS 功率器件导入情况 |
| `foc_para.m` | 参数脚本 | 提供 PWM 频率、母线电压、电机参数、电流环/速度环公式 |
| `run_axdr_pid_speedloop_demo.m` | 无 SPS 数值仿真 | 不依赖 Simscape，快速生成报告曲线和 CSV |
| `create_x7_foc_speedloop_basic_pid.m` | R2025b-safe 仿真模型生成脚本 | 自动生成一个只含离散 PID + 机械对象的 `.slx` |
| `create_x7_pid_controller_codegen.m` | controller-only 代码生成模型 | 把接口收敛为 `ref_rpm, speed_rpm -> iq_cmd_a` |
| `report_outputs/` | 仿真输出 | 保存 `axdr_pid_speedloop_demo.csv/.png` 等报告素材 |

这里最重要的分界线是：`x7_foc_speedloop` 这种完整模型适合说明控制对象和闭环结构，但不适合直接搬到 STM32 工程；`x7_pid_controller_codegen` 这种 controller-only 模型才接近嵌入式接口，因为它不再包含逆变器、PMSM plant、Scope、To Workspace 和测试激励，只留下可落到 C 函数的控制器输入输出。

## 原始 Simulink 参数与 M2006 参数替换

`foc_para.m` 是仿真到工程的第一层接口。原模型里给出了 20 kHz 开关频率、24 V 母线、PMSM 参数、电流环带宽、速度环推导公式、SMO/PLL 参数以及弱磁相关参数。文章里需要特别说明：这些参数不是全部照抄到 M2006 上，而是保留公式和控制结构，再把电机对象换成实物台架的 M2006。

原始脚本里与本次最相关的参数如下：

```matlab
SwitchFrequency = 20e3;
Ts = 1 / SwitchFrequency;
vbus = 24;

Np = 4;
Rs = 0.45;
Ls = 0.00042;
Ld = 0.00042;
Lq = 0.00042;
Flux = 0.00525;
Jx = 0.000004483738;

CurrentLoopBandwidth = 500 * 2 * pi;
id_kp = Ls * CurrentLoopBandwidth;
id_ki = Rs * CurrentLoopBandwidth;
iq_kp = Ls * CurrentLoopBandwidth;
iq_ki = Rs * CurrentLoopBandwidth;
vd_limit = vbus / sqrt(3);
vq_limit = vbus / sqrt(3);
```

迁移到 AXDR-L 时，保留了几个关键思想：

1. PWM / 电流环频率仍按 20 kHz 设计。
2. 电流环带宽仍以 500 Hz 为初始目标。
3. Id/Iq PI 仍使用 `Kp=L*wc`、`Ki=R*wc`，只替换为 M2006 的 `Rs/Ls`。
4. SVPWM 线性区仍受 `Vbus/sqrt(3)` 限制。
5. 速度环仍让外环输出转矩电流，也就是工程里的 `Iq_ref`。

真正替换掉的是电机对象：原脚本的 `Np=4`、`Ls=0.42 mH`、`Flux=0.00525 Wb`、`Jx=4.48e-6 kg*m^2` 更像教学模型参数；实机工程改为 M2006：7 极对、36:1 减速箱、相电阻 0.461 ohm、相电感 64.22 uH、输出轴转矩常数 0.18 N*m/A、输出轴惯量 0.0008 kg*m^2、机械时间常数 0.05278 s。

映射到固件后，参数集中在 `User/motor/axdr_motor_config.h`：

```c
#define AXDR_SUPPLY_NOMINAL_V 24.0f
#define AXDR_CURRENT_LIMIT_A 8.5f
#define AXDR_CURRENT_TRIP_A 10.5f

#define AXDR_M2006_POLE_PAIRS 7.0f
#define AXDR_M2006_GEAR_RATIO 36.0f
#define AXDR_M2006_PHASE_RESISTANCE_OHM 0.461f
#define AXDR_M2006_PHASE_INDUCTANCE_H 0.00006422f
#define AXDR_M2006_OUTPUT_KT_NM_PER_A 0.18f
#define AXDR_M2006_OUTPUT_J_KGM2 0.0008f
#define AXDR_M2006_MECH_TAU_S 0.05278f

#define AXDR_CURRENT_LOOP_BW_HZ 500.0f
#define AXDR_CURRENT_LOOP_V_LIMIT_V 8.5f
#define AXDR_CURRENT_LOOP_I_TERM_LIMIT_V 6.5f
#define AXDR_CURRENT_LOOP_DECOUPLE_ENABLE 0
```

其中磁链没有手写死值，而是由输出轴转矩常数和减速比反推到电机高速轴：

```text
Kt_motor = Kt_output / gear_ratio
flux = Kt_motor / (1.5 * pole_pairs)
      = 0.18 / 36 / (1.5 * 7)
      ≈ 4.76e-4 Wb
```

这个值后面只用于 FOC 参数和可能的解耦/观测器扩展；本次 300 rpm 内，电流环解耦关闭，重点先保证采样、角度和限流稳定。

## R2025b 兼容处理与为什么不用完整模型直接生成代码

原始 `x7_foc_speedloop.slx` 含有电力电子器件和 PMSM 物理对象。迁移到 MATLAB R2025b 后，部分 Specialized Power Systems / Simscape 元件需要转换。导入报告显示：6 个 MOSFET 块为 partially supported，主要是体二极管电感和初始电流参数未完整导入；PMSM、直流电压源和电压测量块可以导入。

这说明模型仍然可以作为控制结构参考，但如果直接对完整模型做嵌入式代码生成，会混进很多不适合 MCU 的内容：

1. MOSFET / PMSM plant 属于仿真对象，上板后由真实逆变器和真实电机替代。
2. Scope、To Workspace、测试激励不应该进入固件主循环。
3. 变量步长求解器不适合实时电机控制，必须改成 fixed-step discrete。
4. STM32 上的 ADC/PWM 同步、死区、R_EN、故障停机、编码器 SPI 都不在原模型内。

因此我把模型处理分成两条线：一条线保留完整仿真用于报告说明，另一条线把控制器剥离出来，用固定步长、明确输入输出的形式接近嵌入式实现。

`set_x7_codegen_fixed_step.m` 做的事情很直接：

```matlab
set_param(model, ...
    'SolverType', 'Fixed-step', ...
    'Solver', 'FixedStepDiscrete', ...
    'FixedStep', '1e-4', ...
    'AutoInsertRateTranBlk', 'on');

try
    set_param(model, 'SystemTargetFile', 'ert.tlc');
catch
    set_param(model, 'SystemTargetFile', 'grt.tlc');
end
```

这里的 `1e-4` 是 10 kHz 仿真步长，不是最终电流环 ISR 频率。它用于桌面速度环验证和代码生成检查；实机闭环最终采用 20 kHz 电流环和 1 kHz 速度环。

## 无 SPS 数值仿真：先验证控制思路

为了不被 R2025b 的 SPS/Simscape 兼容问题卡住，先写了 `run_axdr_pid_speedloop_demo.m`。这个脚本把完整三相逆变器和 PMSM 电磁细节简化为输出轴机械方程：

```text
J * dω/dt = Kt * Iq - B * ω - Tload
B = J / tau
```

在脚本里，速度环仍然按离散 PID + 前馈 + 限流计算 `Iq`：

```matlab
ref = refRpm(k) * 2*pi/60;
err = ref - speed;
derr = (err - lastErr) / Ts;
ff = B * ref / Kt;
uUnsat = Kp * err + Ki * integrator + Kd * derr + ff;
u = min(max(uUnsat, -iqLimit), iqLimit);

if u == uUnsat
    integrator = integrator + err * Ts;
end

speedDot = (Kt * u - B * speed - loadTorque(k)) / Jx;
speed = speed + speedDot * Ts;
```

仿真激励也刻意设计成和后续实机测试类似：0.03 s 给 150 rpm，0.25 s 加 0.05 N*m 负载扰动，0.32 s 切到 90 rpm。这样能观察三件事：启动阶段是否撞限流，负载进入后积分能否补偿，参考下降时是否出现长时间超调。

![AXDR PID 速度环桌面仿真](/img/articles/axdr-x7/axdr-pid-speedloop-demo.png)

这组无 SPS 仿真输出 `5001` 个样本，最高速度约 `163.11 rpm`，`Iq` 上限被限制在 `2 A`，0.45 s 后平均绝对误差约 `6.96 rpm`，0.5 s 末速度约 `85.39 rpm`、目标为 `90 rpm`。这个结果没有被当作实机性能结论，只作为控制器方向正确、限流/积分逻辑合理的桌面检查。

## Controller-only 模型：把接口收敛成嵌入式函数

下一步是 `create_x7_pid_controller_codegen.m`。它不再生成完整电机系统，而是只保留两个输入、三个输出：

```text
输入：ref_rpm, speed_rpm
输出：iq_cmd_a, error_rpm, integrator_rpm_s
```

模型内部 MATLAB Function 与脚本中的控制器一致：

```matlab
function [iq_cmd_a, error_rpm, integrator_rpm_s] = x7_pid_controller(ref_rpm, speed_rpm)
%#codegen
persistent integrator_rad error_last_radps

Kt = 0.18;
B = 0.0008 / 0.05278;
Ts = 0.0001;
Kp = 0.08;
Ki = 2.0;
Kd = 0.0;
iqLimit = 2.0;

ref_radps = ref_rpm * 2.0 * pi / 60.0;
speed_radps = speed_rpm * 2.0 * pi / 60.0;
error_radps = ref_radps - speed_radps;
feedforward_iq_a = B * ref_radps / Kt;
iq_unsat_a = Kp * error_radps + Ki * integrator_rad + feedforward_iq_a;
iq_cmd_a = min(max(iq_unsat_a, -iqLimit), iqLimit);
```

这个模型的价值不是生成最终代码，而是逼迫自己把控制器接口讲清楚：速度环只应该知道 `ref_rpm` 和 `speed_rpm`，输出只能是 `Iq_ref`，不能直接操作 PWM，也不能读 ADC 寄存器。等到进入 STM32 工程，`speed_rpm` 由 MT6816 估计器提供，`Iq_ref` 交给 20 kHz 电流环执行。

## 板端安全演示：先跑 C 版本仿真，不开三相 PWM

进入 `3.AXDR_X7_Speedloop` 工程后，第一版不是直接驱动电机，而是做 `sim2board_demo.c`：把 `run_axdr_pid_speedloop_demo.m` 的离散速度环和一阶机械对象搬到 STM32 上运行，USB/VOFA 输出曲线，同时保持相 PWM 关闭。

这个阶段的 CMake 开关如下：

```cmake
option(AXDR_SIM2BOARD_DEMO "Run safe PID/encoder telemetry demo with phase PWM disabled" ON)
option(AXDR_ESMO_MATH_DEMO "Run ESMO math telemetry demo with phase PWM disabled" OFF)
option(AXDR_HW_TELEMETRY_DEMO "Run hardware ADC/encoder/protection telemetry with phase PWM disabled" OFF)
option(AXDR_LIVE_OPENLOOP_TEST "Run low-power open-loop motor rotation test" OFF)
option(AXDR_LIVE_SPEED_PID_TEST "Run low-power PID speed-loop motor test" OFF)
```

同时工程强制只允许一个模式打开：

```cmake
math(EXPR AXDR_DEMO_MODE_COUNT "${AXDR_SIM2BOARD_DEMO_VALUE} + ${AXDR_ESMO_MATH_DEMO_VALUE} + ${AXDR_HW_TELEMETRY_DEMO_VALUE} + ${AXDR_LIVE_OPENLOOP_TEST_VALUE} + ${AXDR_LIVE_SPEED_PID_TEST_VALUE}")
if(AXDR_DEMO_MODE_COUNT GREATER 1)
  message(FATAL_ERROR "Enable only one AXDR demo mode at a time")
endif()
```

这样做的目的很明确：在没有任何三相输出风险的情况下，先证明下面几件事：

1. 工程可以用 GCC/CMake 编译出 ELF/HEX/BIN。
2. USB CDC 和 VOFA 帧格式正常。
3. MATLAB 中的离散 PID 能在 STM32 单精度浮点下跑出同类曲线。
4. MT6816 原始角度、状态字能跟随遥测输出。
5. 主循环调度和 20 ms 发送周期不会卡死。

`sim2board_demo.c` 里板端机械对象就是仿真方程的 C 实现：

```c
static float plant_step(float current_speed_radps, float iq_cmd_a, float load_torque_nm)
{
    const float iq_limited_a = clampf_local(iq_cmd_a,
                                            -SIM2BOARD_IQ_LIMIT_A,
                                            SIM2BOARD_IQ_LIMIT_A);
    const float speed_dot = (SIM2BOARD_KT_NM_PER_A * iq_limited_a
        - SIM2BOARD_B_NMS * current_speed_radps - load_torque_nm) / SIM2BOARD_J_KGM2;

    return current_speed_radps + speed_dot * SIM2BOARD_DT_S;
}
```

它每 1 ms 执行 10 个 `0.0001 s` 仿真步，20 ms 发一次 VOFA。这个模式下 `foc_pwm_stop()` 会在初始化时执行，所以它本质上是“板端运行的仿真代码”，不是电机实转。

## 从仿真对象到真实无刷驱动工程

仿真里通常可以把对象画成“逆变器 + PMSM + 传感器 + Scope”，但实机工程必须把这些抽象替换成具体外设和具体文件。最终工程结构如下：

```text
3.AXDR_X7_Speedloop
  Core/Src/main.c              外设初始化、模式选择、主循环、TIM3 tick
  Core/Src/adc.c               ADC1/ADC2 注入通道、触发源、采样时间
  Core/Src/tim.c               TIM1 三相 PWM、CH4 ADC 触发、TIM3 1 kHz tick
  Core/Src/spi.c               MT6816 磁编码器 SPI
  USB_Device/App/usbd_cdc_if.c USB CDC 收发，把字符命令转给 live_speed_test
  User/motor/axdr_motor_config.h  M2006、MT6816、限流、电流环带宽
  User/motor/foc_calc.c        Clarke / Park / inverse Park / SVPWM
  User/motor/foc_drv.c         ADC 换算、Id/Iq PI、PWM start/stop、FOC 主流程
  User/motor/foc_ctrl.c        ADC injected 回调、故障检测、旧状态机入口
  User/motor/encoder_mt6816.c  MT6816 raw angle 和状态读取
  User/motor/live_speed_test.c 实机速度环、profile、电角度校准、保护、VOFA
  User/motor/speed_display.c   LCD 曲线和状态显示
  tools/validate_live_speed_test.py 早期 2 A 验证脚本
  tools/run_hs300_test.py      100/300 rpm 自动化验收脚本
```

仿真模块和实机文件的对应关系如下：

| 仿真概念 | 实机落点 | 迁移要点 |
| --- | --- | --- |
| 三相逆变器 | `TIM1 CH1/2/3 + CH1N/2N/3N`、`foc_pwm_start/stop()` | 需要互补 PWM、死区、CCR 更新、R_EN 使能和安全关闭 |
| SVPWM | `foc_calc.c::svm()`、`foc_pwm_run()` | 仿真输出占空比，实机要限制在 0..1 并写入 TIM1 CCR |
| PMSM plant | 真实 M2006 + AXDR 功率级 | plant 不进固件，换成 ADC 电流、编码器速度和真实机械响应 |
| 电流采样 | `ADC1->JDR1..JDR3`、1 mOhm、20x 放大 | 需要零偏校准和 A/LSB 换算 |
| 母线电压 | `ADC2->JDR1`、20k/1k 分压 | Vbus 用于保护和电压矢量限幅 |
| 机械角/速度 | MT6816 SPI raw angle | 需要 unwrap、减速比、方向、offset 和低通预测 |
| 速度 PID | `live_speed_test.c::pid_iq_cmd()` | 输出 `Iq_ref`，不是直接输出 PWM |
| 电流 PI | `foc_drv.c::foc_curr()` | 20 kHz ISR 内执行，输出 `Vd/Vq` |
| Scope / To Workspace | VOFA 48 通道 + CSV/JSON | 保留可复核数据，而不是只看屏幕曲线 |
| 仿真 stop condition | `abort_current_count`、fault、脚本阈值 | 实机必须有明确停机路径 |

## 工程初始化顺序

`main.c` 中的初始化顺序按真实电机控制需求展开：先配 GPIO/DMA/SPI/TIM/USB/ADC，再启动 ADC injected 和 TIM1 CH4 触发，最后初始化 PMSM 参数、编码器和测试任务。

```c
MX_GPIO_Init();
MX_DMA_Init();
MX_SPI1_Init();
MX_TIM1_Init();
MX_TIM3_Init();
MX_USB_Device_Init();
MX_ADC1_Init();
MX_ADC2_Init();

HAL_ADCEx_Calibration_Start(&hadc1, ADC_SINGLE_ENDED);
HAL_ADCEx_Calibration_Start(&hadc2, ADC_SINGLE_ENDED);
HAL_ADCEx_InjectedStart_IT(&hadc1);
HAL_ADCEx_InjectedStart(&hadc2);

__HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_4, 3900);
HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_4);

pmsm_init();
encoder_init();
speed_display_init();
live_speed_test_init();
```

这里 `TIM1_CH4` 不参与三相输出，而是作为 ADC 注入采样触发点；真正三相输出由 CH1/2/3 和互补通道 CH1N/2N/3N 完成。ADC1 用中断启动，因为 ADC1 的 JDR1..JDR3 是三相电流；ADC2 只采 VBUS，不开 JEOS 中断，避免一个 PWM 周期里把 FOC 算两次。

主循环只做慢任务：

```c
while (1) {
    live_speed_test_task();
    speed_display_task(live_speed_test_get_sample());
}
```

TIM3 的 1 kHz 中断不直接读 SPI，也不直接跑复杂控制，而是只投递 tick：

```c
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim != NULL && htim->Instance == TIM3) {
    live_speed_test_speed_tick_isr();
    speed_display_tick_isr();
  }
}
```

这样可以避免在定时器中断里阻塞等待 MT6816 SPI，同时还能用 `speed_ticks_pending` 统计是否有速度环 tick 丢失。

## 开发流程拆解

按时间推进，整个 AXDR-L 速度环工程可以拆成八个阶段。每个阶段都只解决一个风险点，确认之后再进入下一层闭环。

| 阶段 | 目标 | 主要文件 / 开关 | 验证方式 | 进入下一阶段的条件 |
| --- | --- | --- | --- | --- |
| 0. 仿真参数整理 | 从 X7 模型中抽出采样频率、PMSM 参数、电流环带宽和速度环结构 | `foc_para.m`、`x7_foc_speedloop.slx` | 检查 `20e3` PWM、`500 Hz` 电流环带宽、`vbus/sqrt(3)` 电压限制 | 明确哪些参数沿用公式，哪些必须替换为 M2006 实测/资料值 |
| 1. 兼容性修复 | 让 R2025b 能打开和更新模型 | `x7_foc_speedloop_R2025b_latched.slx`、`set_x7_codegen_fixed_step.m` | fixed-step update，不依赖变量步长 | 模型能更新，且不再把 solver 问题当作控制问题 |
| 2. 桌面等效仿真 | 在不依赖 SPS/Simscape 的情况下复现速度环响应 | `run_axdr_pid_speedloop_demo.m` | 生成 `axdr_pid_speedloop_demo.csv/.png` | 速度环输出方向、限流、负载扰动响应合理 |
| 3. 控制器接口收敛 | 把控制器变成嵌入式可接受的输入输出 | `create_x7_pid_controller_codegen.m` | 接口固定为 `ref_rpm + speed_rpm -> iq_cmd_a` | 速度环不依赖仿真 plant、Scope 或 Workspace |
| 4. 板端仿真代码 | 把离散 PID 放到 STM32 上跑，但关闭相 PWM | `AXDR_SIM2BOARD_DEMO=ON`、`sim2board_demo.c` | VOFA 输出 ref/speed/iq/error，三相 PWM 保持关闭 | 证明 USB、VOFA、调度和浮点计算可用 |
| 5. 硬件遥测 | 不转电机，先确认采样和状态可观察 | `AXDR_HW_TELEMETRY_DEMO=ON`、`hw_telemetry_demo.c` | 观察 ADC、VBUS、MT6816、TIM1、R_EN | 采样比例、编码器状态、保护字段可信 |
| 6. 低功率开环 | 用小 `Vq` 验证三相输出、相序和角度方向 | `AXDR_LIVE_OPENLOOP_TEST=ON`、`foc_volt()` | 限流电源 + VOFA，确认无 fault/abort | 电机可按预期方向缓慢转动，停机能关 PWM/R_EN |
| 7. 低速闭环 | 低电流下建立 MT6816 电角度 offset 和基础速度闭环 | `AXDR_LIVE_SPEED_PID_TEST=ON`、`live_speed_test.c` | 40/50 rpm 测试，检查 eangle、Iq、Vd/Vq、dt | 角度校准、20 kHz 电流环、1 kHz 速度环同时成立 |
| 8. 100/300 rpm 调参 | 把课程设计从演示扩展到 100/300 rpm 可重复验证 | `run_hs300_test.py`、低/中/高速参数表 | `M/H/G/P/R/T` 固定命令，输出 CSV/JSON | 保持测试无 fault/abort，脚本结束后 idle 安全 |

这个阶段化推进比“直接闭环调 PID”慢一些，但能把错误定位清楚：桌面仿真有问题就是控制器公式问题；板端仿真有问题就是 C 移植/通信问题；硬件遥测有问题就是采样或接口问题；开环有问题才去查相序、PWM、驱动和电机；最后闭环有问题才调速度环和电角度。

### 实际构建目标

GCC/CMake 侧使用 preset 管理不同阶段，避免手改宏导致测试状态混乱：

```powershell
cmake --preset gcc-live-check
cmake --build --preset gcc-live-check

cmake --preset gcc-hw-telemetry
cmake --build --preset gcc-hw-telemetry

cmake --preset gcc-live-openloop
cmake --build --preset gcc-live-openloop

cmake --preset gcc-live-speed-pid
cmake --build --preset gcc-live-speed-pid
```

Keil/MDK 侧保留 `MDK-ARM/AxDr.uvprojx`，target 名为 `AxDr`。最终可下载产物是 `MDK-ARM/AxDr/AxDr.hex`；GCC 侧产物是 `build/gcc-live-speed-pid/AxDr_X7_Speedloop.elf/.hex/.bin`。课程报告里我更倾向写清楚两条构建链：MDK 用于最终下载和同学复现，GCC/CMake 用于快速模式切换和 CI 风格的编译检查。

### 验证命令

早期 2 A 低风险阶段用 `validate_live_speed_test.py`，它关注“基础闭环是否可信”：帧数、通道数、VBUS 范围、电流限制、MT6816 状态、fault/abort、PWM/R_EN 状态、速度环 dt 和电流环 20 kHz 频率。

```powershell
python tools\validate_live_speed_test.py --port COM37 --expected-mode 2 --command S --duration 8
```

后期 100/300 rpm 阶段用 `run_hs300_test.py`，它关注“固定 profile 下指标是否可复现”：

```powershell
python tools\run_hs300_test.py X M H G --port COM37
```

脚本会在每次测试前先发 `X`，测试结束后再发 `X` 并记录 `idle.csv`，所以日志里同时包含运行段和停机段。这个习惯很重要，因为对电机控制来说，“跑起来”只是一半，“能明确停下来且没有 fault/abort 残留”才是完整验证。

## 项目定位与最终结果

这次课程设计的对象是 AXDR / AxDrive-L 平台，主控为 STM32G474RETx，电机为 DJI M2006 减速无刷电机，位置反馈使用 MT6816 14 bit 磁编码器。最初目标只是复现 X7 速度环 PID，但实际落板后，工作量主要集中在三个方向：

1. 把 Simulink 中的速度环输出映射成真实 `Iq_ref`，由内层 FOC 电流环闭环执行。
2. 解决真实硬件上电角度方向、offset、ADC 采样触发、PWM 安全关闭等仿真里没有的问题。
3. 用串口遥测和脚本把“能跑一次”变成可重复的 10 / 100 / 300 rpm 测试。

最终版本在 24 V 供电、M2006 + MT6816 台架上完成了 100 rpm 保持、300 rpm 保持和 86 s 自动序列测试。最终验收用的四组 `hs300` 日志如下：


| 测试         | 指令 | 目标上限 |   最高实速 |   late MAE | >250 rpm MAE |    电流 max / P95 / P99 | ISR 峰值电流 | fault / abort | 停机验证      |
| -------------- | ------ | ---------: | -----------: | -----------: | -------------: | ------------------------: | -------------: | --------------: | --------------- |
| 停机空闲     | `X`  |    0 rpm |   0.00 rpm |         NA |           NA | 0.200 / 0.123 / 0.164 A |      0.606 A |         0 / 0 | PWM=0, R_EN=0 |
| 100 rpm 保持 | `M`  |  100 rpm | 105.23 rpm |  1.503 rpm |           NA | 1.855 / 0.365 / 0.561 A |      8.221 A |         0 / 0 | PWM=0, R_EN=0 |
| 300 rpm 保持 | `H`  |  300 rpm | 308.47 rpm |  3.805 rpm |   10.731 rpm | 7.571 / 2.012 / 4.272 A |     17.927 A |         0 / 0 | PWM=0, R_EN=0 |
| 自动序列     | `G`  |  300 rpm | 308.80 rpm | 29.060 rpm |   12.873 rpm | 7.937 / 1.333 / 4.110 A |     20.707 A |         0 / 0 | PWM=0, R_EN=0 |

这里的 `current_peak_max` 是 20 kHz 电流环 ISR 窗口中抓到的瞬时峰值，更适合当作诊断量；稳定运行时更看 `current_abs_a` 的 P95 / P99 和是否触发 fault / abort。最终版本没有留下故障锁存，脚本结束后也会发送 `X` 并采集 idle 段，确认 `PWM=0`、`R_EN=0`。

## 硬件与关键约束

本项目不是理想仿真对象，而是直接跑在 AXDR 功率板上的闭环控制。几个约束会直接影响程序结构和参数选择：


| 项目           |                          当前值 | 说明                                       |
| ---------------- | --------------------------------: | -------------------------------------------- |
| 母线电压       |                  24.0 V nominal | 软件保护窗口 18..30 V                      |
| 电机           |                       DJI M2006 | 带 36:1 减速箱                             |
| 极对数         |                               7 | 电角速度换算使用                           |
| 减速比         |                            36:1 | 编码器在高速轴时，输出轴 rpm 需要除以 36   |
| 相电阻`Rs`     |                       0.461 ohm | 电流环 PI 整定参数                         |
| 相电感`Ls`     |                        64.22 uH | 电流环 PI 整定参数                         |
| 输出轴转矩常数 |                      0.18 N*m/A | 速度环前馈估算参考                         |
| 输出轴转动惯量 |                   0.0008 kg*m^2 | Simulink 机械对象参考                      |
| 机械时间常数   |                       0.05278 s | 用于阻尼和惯量估算                         |
| 编码器         |                          MT6816 | 14 bit, 16384 counts/rev, SPI timeout 2 ms |
| 当前电流限制   | 8.5 A soft / 10.5 A derate-zero | 300 rpm 阶段使用的源码值                   |
| 电流环电压限制 |                           8.5 V | 同时受`Vbus/sqrt(3)` 限制                  |

板级采样参数来自 `pmsm_board_init()`：ADC 参考 3.3 V、12 bit 量化、相电流采样电阻 1 mOhm、电流放大倍数 20，母线分压为 20 kOhm / 1 kOhm。换算后相电流约为 `0.0403 A/LSB`，母线电压约为 `0.0169 V/LSB`。

## 程序框架

实际固件没有把 Simulink 代码直接贴进主循环，而是拆成了“测试调度层 + 速度环 + 电流环 + 底层 FOC + 遥测工具链”的结构。

```text
Core/Src/main.c
  ├─ MX_TIM1_Init()         三相互补 PWM / advanced timer
  ├─ MX_TIM3_Init()         1 kHz 速度环 tick
  ├─ MX_USB_Device_Init()   USB CDC / VOFA / host command
  ├─ MX_ADC1_Init()         三相电流 injected sequence
  ├─ MX_ADC2_Init()         VBUS injected sample
  ├─ HAL_ADCEx_InjectedStart_IT(&hadc1)
  ├─ HAL_ADCEx_InjectedStart(&hadc2)
  ├─ live_speed_test_init()
  └─ while(1)
       ├─ live_speed_test_task()
       └─ speed_display_task(live_speed_test_get_sample())

User/motor/live_speed_test.c
  ├─ profile_ref_rpm()      G/P/R/T/L/M/H/S 等目标速度生成
  ├─ output_speed_from_pos() MT6816 角度差分 + 滤波 + 预测
  ├─ pid_iq_cmd()           分速度段 PID/前馈/阻尼/刹车
  ├─ speed_loop_step()      1 kHz 外环状态机
  ├─ current_loop_step()    20 kHz 电流环入口
  └─ send_sample()          48 通道 VOFA JustFloat

User/motor/foc_drv.c / foc_calc.c
  ├─ foc_adc_sample()       ADC JDR -> Ia/Ib/Ic/Vbus
  ├─ foc_curr()             Clarke/Park -> Id/Iq PI -> inverse Park -> SVM
  ├─ foc_pwm_start/stop()   TIM1 CH/CHN + R_EN
  └─ svm()                  扇区法 SVPWM 占空比
```

实时调度上，电流环和速度环分离：


| 调度源              |         频率 | 执行内容                                                    | 设计原因                       |
| --------------------- | -------------: | ------------------------------------------------------------- | -------------------------------- |
| TIM1 + ADC injected |       20 kHz | ADC1 注入转换完成后进入`live_speed_test_current_loop_isr()` | 电流环必须跟 PWM 周期同步      |
| TIM3                |        1 kHz | ISR 只累加`speed_ticks_pending`                             | 避免在中断里阻塞 SPI 读 MT6816 |
| main loop           |     事件驱动 | 消费速度 tick、处理按键、处理 USB 命令、发送 VOFA           | 把慢速 IO 留在主循环           |
| VOFA send           |        20 ms | 发送 48 个 float + JustFloat 帧尾                           | 50 Hz 遥测足够看速度/电流趋势  |
| LCD update          | 200 / 500 ms | 曲线 200 ms，数值 500 ms 分步刷新                           | 避免 ST7789 DMA 长时间抢占     |

ADC 回调里只让 ADC1 触发 FOC：ADC1 的 JDR1..JDR3 是完整三相电流序列，ADC2 只采 VBUS，并且刻意不开 JEOS 中断，防止一个 PWM 周期内重复调用电流环。

## 控制算法链路

当前固件的控制链路可以概括为：

```text
MT6816 raw angle
  -> 机械角 unwrap / 方向修正 / 输出轴速度换算
  -> 速度估计低通、加速度限幅、1 ms 预测
  -> profile 目标速度与参考斜率限制
  -> 低/中/高速分段速度控制器
  -> Iq_ref / Id_ref
  -> 20 kHz Id/Iq 电流 PI
  -> Vd/Vq 矢量限幅
  -> inverse Park
  -> SVPWM
  -> TIM1 CH1/2/3 + CH1N/2N/3N + R_EN
```

### 电角度校准与编码器交接

早期如果直接用编码器电角度闭环，容易遇到方向不确定、offset 错误、某些启动周期抖动或拉不起的问题。最终策略是在每次测试启动前做低电流开环校准：


| 参数              |          当前值 | 含义                           |
| ------------------- | ----------------: | -------------------------------- |
| 校准开始时间      |          0.50 s | 上电/启动后先保持安全状态      |
| 采样开始时间      |          1.20 s | 避开初始瞬态                   |
| 最长校准时间      |          6.50 s | 超时后强制 finalize / fallback |
| 开环等效输出速度  |         1.5 rpm | 慢速拖动转子                   |
| 校准`Id_ref`      |          0.35 A | 建立 d 轴定向磁场              |
| 校准`Iq_ref`      |             0 A | 校准阶段不主动给转矩           |
| 最小累计转角      |   `2 * 2pi` rad | 至少约两圈高速轴机械角         |
| 最小样本          |             300 | 保证 offset 均值有足够样本     |
| 校准电压/积分限幅 | 0.35 V / 0.30 V | 降低校准阶段风险               |
| 交接等待          |          1.00 s | 清 PID 后再进编码器闭环        |

校准时固件用开环电角度 `theta_e` 拖动电机，同时持续读取 MT6816；满足最小样本和最小转角后，根据 `theta_cmd_e - theta_encoder_raw_e` 的圆均值计算电角度 offset，并判断编码器方向。最终 50 rpm 安全验证中 `eangle_cal_delta_rad=12.572 rad`，`eangle_dir=1`，说明电角度方向和 offset 交接稳定。

### 速度估计器

速度估计不是简单的 `rpm = diff / dt`，因为 MT6816 在高速轴，低速段量化明显，高速段又会遇到 unwrap 和跳变。当前 `output_speed_from_pos()` 做了几层处理：

1. 根据上一次速度预测当前角度差，把角度增量 unwrap 到最接近预期的位置。
2. 如果 MT6816 在高速轴，先算高速轴 rpm，再除以 `AXDR_M2006_GEAR_RATIO=36` 得到输出轴 rpm。
3. 对速度做 `0.85..1.15` 的标定比例限制，防止校准比例跑飞。
4. 速度绝对值限制在 `620 rpm`。
5. 当速度超过 `120 rpm` 时启用异常跳变抑制，跳变阈值为 `max(0.12 * |speed|, 28 rpm)`。
6. 低通系数按 tick 缩放，基础 `alpha=0.025`，最大 `0.08`。
7. 单次速度变化限制为 `2000 rpm/s * dt`。
8. 对速度斜率再做 `0.08` 的一阶滤波，并向前预测 `1 ms`，预测补偿限制在 `±5 rpm`。

这套估计器的关键取舍是：低速不能太抖，高速不能太慢。后面调参中试过继续降低带宽，但 100 rpm 保持误差反而变大，最后回到 1 ms 控制路径，用分段刹车解决超调。

### 速度环：分段 PID + 前馈 + 阻尼 + 超速刹车

速度环输出不是 PWM，而是 `Iq_ref`。核心形式如下：

```text
error_rpm = ref_rpm - speed_rpm
iq_ff     = iq_ff_base + iq_ff_per_rpm * ref_rpm
damping   = clamp(Kd * speed_slope_rpm_s, 0, damping_limit)
iq_unsat  = iq_ff + Kp * error_rpm + Ki * integral - damping

if breakaway:
    iq_unsat = max(iq_unsat, breakaway_iq)

if overspeed:
    brake = clamp(brake_min + brake_gain * overspeed_rpm, brake_min, iq_brake_max)
    iq_unsat = min(iq_unsat, -brake)

iq_ref = clamp(iq_unsat, -iq_brake_max, iq_drive_max)
iq_ref = slew_limit(iq_ref, region_slew)
```

速度区域由参考速度和实际速度共同决定，带滞回，防止在边界来回跳：


| 区域 | 进入/退出逻辑                                     | 用途                                    |
| ------ | --------------------------------------------------- | ----------------------------------------- |
| Low  | 低速进入 25 rpm，退出 35 rpm；低速参考退出 25 rpm | 克服减速箱静摩擦，提供 breakaway torque |
| Mid  | 约 35..160 rpm                                    | 50 / 100 rpm 的主要工作区               |
| High | 进入 180 rpm，退出 140 rpm                        | 180..300 rpm 加速和保持                 |

当前三段参数如下。单位按字段名理解：`Kp=A/rpm`，`Ki=A/(rpm*s)`，`Kd=A/(rpm/s)`，slew 为 `A/s`。


| 区域 | FF base | FF/rpm | Iq max | Brake max | Iq slew | Brake slew | Overspeed brake           |    Kp |    Ki |     Kd | Damping max | Int limit | Breakaway |
| ------ | --------: | -------: | -------: | ----------: | --------: | -----------: | --------------------------- | ------: | ------: | -------: | ------------: | ----------: | ----------: |
| Low  |    0.05 | 0.0025 |   1.20 |      1.10 |    5.00 |      14.00 | 0.06 + 0.012/rpm, slew 24 | 0.020 | 0.025 | 0.0012 |        0.10 |        20 |      0.80 |
| Mid  |    0.03 | 0.0017 |   2.60 |      2.30 |   24.00 |      34.00 | 0.08 + 0.020/rpm, slew 28 | 0.016 | 0.015 | 0.0011 |        0.30 |        42 |      0.65 |
| High |    0.02 | 0.0012 |   3.80 |      2.50 |   40.00 |      55.00 | 0.16 + 0.045/rpm, slew 80 | 0.012 | 0.006 | 0.0018 |        1.20 |        20 |      0.60 |

几个比较实际的处理：

- `ref_rpm <= 0.1` 时直接清速度 PID 并停止输出，避免零速附近积分残留。
- 误差很大且正在接近目标时，阻尼限幅会降低，避免启动阶段被微分项过早压住。
- 参考大于 35 rpm 且已经追上目标时，非超速状态下不允许普通 PID 输出负电流；真正需要制动时由 overspeed brake 接管。
- 超速进入阈值为 `error < -3 rpm`，退出阈值为 `error > -0.6 rpm`，并在超速时用 `5x` 增益回收正向积分。
- `speed_rpm > 360 rpm` 时强制进入安全刹车逻辑。
- 正向驱动、普通回落、超速刹车、低速 breakaway 使用不同 slew rate，避免一套限斜率同时拖慢启动和刹车。

### 电流环与 SVPWM

电流环在 20 kHz 中断路径内运行。`foc_curr()` 的执行顺序是：三相电流 Clarke 变换、按电角度 Park 变换、Id/Iq PI、矢量电压限幅、逆 Park、SVM、更新 TIM1 占空比。

电流 PI 沿用 Simulink 中常见的带宽整定形式：

```text
wc = 2 * pi * 500
Kp = L * wc = 64.22e-6 * 3141.59 ≈ 0.202 V/A
Ki = R * wc = 0.461 * 3141.59 ≈ 1448 V/(A*s)
```

当前源码配置：


| 项目               |                         值 | 说明                                  |
| -------------------- | ---------------------------: | --------------------------------------- |
| 电流环频率         |                     20 kHz | `LIVE_CURRENT_LOOP_RATE_HZ`           |
| 电流环带宽         |                     500 Hz | `AXDR_CURRENT_LOOP_BW_HZ`             |
| 正常电压限幅       |                      8.5 V | `AXDR_CURRENT_LOOP_V_LIMIT_V`         |
| PI 积分限幅        |                    ±6.5 V | `AXDR_CURRENT_LOOP_I_TERM_LIMIT_V`    |
| 校准电压限幅       |                     0.35 V | 只用于电角度开环校准                  |
| 校准积分限幅       |                   ±0.30 V | 只用于电角度开环校准                  |
| 解耦前馈           |                       关闭 | `AXDR_CURRENT_LOOP_DECOUPLE_ENABLE=0` |
| SVPWM 线性电压限制 | `min(8.5 V, Vbus/sqrt(3))` | 24 V 下由配置 8.5 V 限制              |

PI 积分不是无条件累加，而是在电压未饱和，或新的矢量幅值比旧矢量更小时才更新积分项。这一点对 300 rpm 阶段很重要，否则电压饱和后的积分释放会造成明显超调。

## 测试指令、UI 与遥测

### USB CDC 指令

USB CDC 使用 ASCII 命令控制测试。脚本默认使用 COM37 / 115200，并且每次测试前先发送 `X` 清状态。


| 命令      |  UI ID | Profile | 当前含义                                    |
| ----------- | -------: | --------: | --------------------------------------------- |
| `G`       |      0 |       0 | 自动序列：10 rpm、100 rpm、300 rpm 多段组合 |
| `U`       |      1 |       7 | 100 rpm pulse                               |
| `V`       |      2 |       8 | 20 -> 100 rpm ramp                          |
| `W`       |      3 |       9 | 0 -> 100 rpm step                           |
| `P`       |      4 |       1 | 300 rpm pulse                               |
| `R`       |      5 |       2 | 50 -> 300 rpm ramp                          |
| `T`       |      6 |       3 | 0 -> 300 rpm step                           |
| `L`       |      7 |       4 | 10 rpm hold                                 |
| `M`       |      8 |      10 | 100 rpm hold                                |
| `H`       |      9 |       5 | 300 rpm hold                                |
| `S`       |     10 |  manual | 固定 80 rpm                                 |
| `X`       |     NA |      NA | 停止输出并进入 idle                         |
| `+` / `-` | manual |  manual | 目标速度按 5 rpm 增减，上限 300 rpm         |

### 按键和 LCD

按键接在 PC9 / PC8 / PC7 / PC6，低电平有效，内部上拉，30 ms 软件消抖。当前交互逻辑是加速、减速、启停切换和恢复默认速度。LCD 使用 ST7789，数值区显示命令、状态、目标 rpm、实际 rpm、误差、电流、母线电压、Vq、Id/Iq；曲线区量程 0..500 rpm，绿色为目标速度，品红为实际速度。

### VOFA 通道

VOFA JustFloat 帧尾为 `00 00 80 7F`，当前高速测试版本发送 48 个 float。核心字段如下：

```text
0 time_s, 1 mode, 2 pwm_enabled, 3 ref_rpm, 4 speed_rpm, 5 error_rpm,
6 vq_cmd_v, 7 pid_integrator, 8 current_abs_a, 9 ia_a, 10 ib_a, 11 ic_a,
12 vbus_v, 13 mt6816_raw, 14 mt6816_pos_rad, 15 mt6816_status,
16 fault_bits, 17 abort_latched, 18 dtc_a, 19 dtc_b, 20 dtc_c,
21 tim1_ccer, 22 tim1_bdtr, 23 r_en,
24 id_ref_a, 25 iq_ref_a, 26 id_a, 27 iq_a, 28 vd_cmd_v, 29 iq_error_a,
30 theta_cmd_e_rad, 31 theta_enc_e_rad, 32 theta_error_e_rad,
33 control_ticks_dropped, 34 theta_enc_raw_e_rad, 35 theta_offset_e_rad,
36 angle_source, 37 eangle_state, 38 id_error_a, 39 eangle_dir,
40 eangle_cal_delta_rad, 41 eangle_cal_samples,
42 speed_loop_dt_ms, 43 current_loop_ticks, 44 current_abs_peak_a,
45 abort_current_count, 46 speed_gain_region, 47 test_profile_id
```

这些通道让调参时可以同时看到速度误差、Iq 请求、真实 Iq、Vd/Vq、电流峰值、TIM1 输出使能、R_EN、角度源和速度参数区，避免只看速度曲线猜问题。

## 自动化验证脚本

`tools/run_hs300_test.py` 是后期 100/300 rpm 验证的主脚本。它做了几件关键的安全动作：

1. 打开串口后先发送 `X`，等待 0.2 s，再发送目标命令。
2. 默认 `G` 采集 86 s，其它命令采集 14 s。
3. 采集过程中实时解析 VOFA，超过 `420 rpm`、瞬时电流超过 `11 A`、滤波电流连续超过 `8.5 A` 或固件 `abort_latched` 都会提前停机。
4. 测试结束强制发送 `X`，继续采集 1.5 s idle 数据。
5. 输出 `run.csv`、`idle.csv`、`summary.json`，summary 中直接计算 late MAE、>250 rpm MAE、P95/P99 电流、Iq/Vd/Vq 最大值、故障状态和停机状态。

这一点很重要：后面很多参数不是凭感觉调的，而是每次改完都跑相同命令，比较同一组指标。

## 测试数据与调参过程

### 早期 2 A 安全阶段

第一阶段电流限制较低，目标是证明采样、编码器、电角度校准和基础闭环可以工作，而不是直接冲高转速。


| 日志                                        |   目标 | 结果 | 关键现象                                                                                  | 结论                                          |
| --------------------------------------------- | -------: | ------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `x7_live_speed_pid_summary_20260908_102913` |  0 rpm | fail | 有 VOFA 帧，VBUS/MT6816 正常，但`pwm_enabled=0`、`r_en=0`、无运动                         | 这是命令/启停路径验证，不是控制性能测试       |
| `x7_live_speed_pid_summary_20260908_015847` | 50 rpm | fail | 最高只有 27.95 rpm，`current_abs_max=2.345 A`，`abort_latched=1` 共 3302 帧               | 2 A 限制下 50 rpm 加速过激，先保护是正确行为  |
| `x7_live_speed_pid_summary_20260908_162723` | 50 rpm | pass | 最高 53.09 rpm，late MAE 0.689 rpm，`current_abs_max=0.555 A`，`current_peak_max=0.733 A` | 角度校准、20 kHz 电流环、1 kHz 速度环闭环成立 |

这一步确认了几个基本事实：MT6816 状态全程为 0，母线在 24.75..25.04 V，速度环 dt 在 1..3 ms，电流环实测频率约 18.44..21.33 kHz，`control_ticks_dropped=0`。

早期 40 rpm 以下的五类输入响应也作为基础回归测试保留：

![40 rpm 安全阶段五类输入响应](/img/articles/axdr-x7/all-profiles-40rpm.png)


| 输入        |         目标 |  最高实速 | 稳态 MAE | 峰值电流 | 结论 |
| ------------- | -------------: | ----------: | ---------: | ---------: | ------ |
| 脉冲        |       38 rpm | 39.21 rpm | 0.68 rpm |  0.840 A | 通过 |
| 斜坡        | 10 -> 35 rpm | 36.04 rpm | 0.69 rpm |  0.807 A | 通过 |
| 阶跃        |       38 rpm | 39.45 rpm | 1.17 rpm |  0.762 A | 通过 |
| 低速保持    |       10 rpm | 13.05 rpm | 0.19 rpm |  0.884 A | 通过 |
| 35 rpm 保持 |       35 rpm | 36.14 rpm | 0.68 rpm |  0.883 A | 通过 |

### 100 rpm 自动序列阶段

在 100 rpm 阶段，自动序列包括 10 rpm 保持、80 rpm 脉冲、20 -> 100 rpm 斜坡、100 rpm 保持、0 -> 100 rpm 阶跃和 100 rpm 高速保持。这个阶段主要用于验证中速参数区、速度估计器和电角度交接是否稳定。

![100 rpm 自动序列速度响应](/img/articles/axdr-x7/auto-sequence-100rpm.png)

![100 rpm 自动序列误差与电流](/img/articles/axdr-x7/auto-sequence-current-100rpm.png)


| 阶段               |   稳态均值 | 稳态 MAE |  稳态 Std |     超调 | P95 电流 | 峰值电流 |
| -------------------- | -----------: | ---------: | ----------: | ---------: | ---------: | ---------: |
| 10 rpm 保持        |  10.04 rpm | 0.10 rpm |  0.12 rpm | 0.59 rpm |   0.20 A |   0.60 A |
| 80 rpm 脉冲        |  80.57 rpm | 0.82 rpm |  0.83 rpm | 2.46 rpm |   0.29 A |   2.63 A |
| 20 -> 100 rpm 斜坡 |  59.90 rpm | 0.89 rpm | 23.98 rpm | 0.93 rpm |   0.24 A |   1.13 A |
| 100 rpm 保持       | 100.95 rpm | 1.01 rpm |  0.68 rpm | 2.96 rpm |   0.28 A |   1.05 A |
| 0 -> 100 rpm 阶跃  | 100.98 rpm | 1.08 rpm |  0.78 rpm | 2.99 rpm |   0.28 A |   2.06 A |
| 100 rpm 高速保持   | 100.92 rpm | 1.00 rpm |  0.72 rpm | 3.79 rpm |   0.28 A |   2.46 A |

这组测试说明中速段已经比较稳，但也暴露了后续 300 rpm 的问题：目标速度变化越激烈，速度估计滞后、正向积分释放和刹车不足就越明显。

### 300 rpm 调参阶段

进入 300 rpm 后，问题不再是“能不能跑”，而是如何控制超调、电流尖峰和 100 rpm 处的速度波动。几次关键日志如下：


| 日志                      | 指令               | 现象                   | 指标                                                 | 调参结论                               |
| --------------------------- | -------------------- | ------------------------ | ------------------------------------------------------ | ---------------------------------------- |
| `hs300_R_20260911_223024` | `R` 50 -> 300 ramp | 触发 abort             | 最高 290.72 rpm，late MAE 11.262 rpm，峰值 28.794 A  | 高速前馈/刹车/电流限制还不够稳         |
| `hs300_R_20260911_223536` | `R`                | 不再 abort，但超调明显 | 最高 325.22 rpm，late MAE 7.676 rpm                  | ramp 可跑，但高速区刹车不足            |
| `hs300_P_20260911_223615` | `P` 300 pulse      | 大脉冲超调             | 最高 348.50 rpm，late MAE 50.361 rpm，P99 5.304 A    | pulse 是压力测试，不能只按保持参数调   |
| `hs300_T_20260911_223630` | `T` 300 step       | 阶跃超调               | 最高 352.17 rpm，late MAE 19.950 rpm，P99 4.509 A    | 需要独立超速刹车和积分回收             |
| `hs300_M_20260912_171446` | `M` 100 hold       | 中速波动仍在           | late MAE 3.352 rpm                                   | 降带宽/放宽死区思路待验证              |
| `hs300_M_20260912_173806` | `M`                | 100 rpm 变差           | late MAE 6.210 rpm                                   | 慢滤波开始拖累闭环                     |
| `hs300_M_20260912_175741` | `M`                | 100 rpm 明显变差       | late MAE 14.320 rpm，最高 117.68 rpm                 | 继续降估计带宽是错误方向               |
| `hs300_R_20260912_120820` | `R`                | ramp 收敛              | 最高 306.12 rpm，late MAE 4.275 rpm，P99 1.203 A     | 恢复快估计后，用分段参数解决高速       |
| `hs300_T_20260912_115731` | `T`                | 阶跃仍是强压力         | 最高 307.74 rpm，step250 MAE 11.197 rpm，P99 4.872 A | 阶跃可安全完成，但不是稳态指标         |
| `hs300_P_20260912_115746` | `P`                | pulse 回零过程误差大   | 最高 308.04 rpm，step250 MAE 26.445 rpm，P99 4.251 A | pulse 用于暴露瞬态，不作为最终保持验收 |

最终修改方向是：不要用更慢的速度滤波去“看起来平滑”，而是恢复 1 ms 速度估计和 PID 路径，把控制权交给低/中/高速三段参数，尤其是 per-region overspeed brake。最终三段超速刹车参数分别为：


| 区域 | 最小刹车电流 |    刹车增益 | 刹车 slew | 目的                       |
| ------ | -------------: | ------------: | ----------: | ---------------------------- |
| Low  |       0.06 A | 0.012 A/rpm |    24 A/s | 低速轻刹，避免齿隙附近抖动 |
| Mid  |       0.08 A | 0.020 A/rpm |    28 A/s | 100 rpm 附近控制波动       |
| High |       0.16 A | 0.045 A/rpm |    80 A/s | 300 rpm 超调后快速拉回     |

最终 300 rpm 保持日志 `hs300_H_20260912_181855` 中，目标 300 rpm，最高 308.47 rpm，late MAE 3.805 rpm，`fault=0`、`abort=0`、停机 idle 也确认 PWM 和 R_EN 均为 0。自动序列 `hs300_G_20260912_181931` 覆盖 10/100/300 rpm 多段，最高 308.80 rpm，全程无 fault/abort；虽然整段 late MAE 为 29.060 rpm，但这是因为 late 窗口包含 300 rpm profile 切换和零速间隔，不能直接等价为 300 rpm 稳态保持误差。

## 优化过程复盘

这次移植中比较关键的修改点如下：

1. **先保证电流环路径唯一。** ADC2 只提供 VBUS，不触发 JEOS 中断；FOC 只从 ADC1 三相电流转换完成回调进入，避免一个 PWM 周期算两次电流环。
2. **把 Simulink 的电流环公式保留下来。** `Kp=L*wc`、`Ki=R*wc` 仍是主线，但加入真实 Vbus、电压矢量限幅、积分限幅和 PWM 使能状态。
3. **启动阶段先校准电角度。** 开环 `Id=0.35 A` 慢速拖动，统计 MT6816 方向和 offset，再交接到编码器电角度闭环。
4. **速度环输出 `Iq_ref`，不直接碰 PWM。** 外环只发布 `Id/Iq/theta` 命令快照，20 kHz ISR 再读取快照执行 FOC。
5. **安全状态独立处理。** `ref=0`、脚本 `X`、固件 abort 和 fault 都会走 `pwm_disable_safe()`，同时关 TIM1 输出和 `R_EN`。
6. **从低限流逐步扩展。** 先在 2 A 下跑通 40/50 rpm，再进入 8.5 A soft / 10.5 A derate-zero 的 100/300 rpm 阶段。
7. **不要用慢滤波掩盖波动。** 100 rpm 变差的几组日志说明，降估计带宽会把相位滞后带进速度环；最后选择恢复快路径，并加入分速度段刹车。
8. **区分保持指标和压力指标。** `H` 代表 300 rpm 保持能力，`P/T/R/G` 代表脉冲、阶跃、斜坡和组合压力测试，不能用同一个 MAE 判据混在一起判断。

## 目前仍需注意的问题

1. `current_abs_peak_a` 会抓到 20 kHz ISR 内的瞬时尖峰，调参时要结合 P95/P99、持续电流、fault/abort 一起看，不能单看峰值下结论。
2. 300 rpm pulse/step 的瞬态误差仍明显，当前参数优先保证安全和保持稳定，没有把阶跃响应调到最激进。
3. 当前电流环解耦前馈关闭，300 rpm 内仍能满足测试；如果后续做更高速或弱磁，需要重新检查 `Vd/Vq` 电压余量和角度延迟补偿。
4. MT6816 安装在高速轴时，速度估计要特别注意减速比、unwrap 和低速量化；换装到输出轴时必须同步修改宏和参数。
5. 这套参数基于当前 AXDR、M2006、MT6816 和台架负载，不应该无脑复制到其它电机或功率板。

## 可复核文件

后续如果要继续改文章或复现实验，可以优先看这些文件：


| 文件                                | 用途                                           |
| ------------------------------------- | ------------------------------------------------ |
| `Core/Src/main.c`                   | 外设初始化、主循环、TIM3 tick 回调             |
| `User/motor/live_speed_test.c`      | 速度环、profile、角度校准、保护、VOFA 发送     |
| `User/motor/live_speed_test.h`      | 48 通道遥测结构体                              |
| `User/motor/axdr_motor_config.h`    | M2006、MT6816、电流限制、电流环带宽参数        |
| `User/motor/foc_ctrl.c`             | ADC injected 回调、故障计数器                  |
| `User/motor/foc_drv.c`              | 电流采样、Id/Iq PI、PWM start/stop、FOC 主流程 |
| `User/motor/foc_calc.c`             | Clarke/Park/inverse Park/SVPWM/SVM             |
| `User/motor/speed_display.c`        | ST7789 显示和 0..500 rpm 曲线                  |
| `tools/run_hs300_test.py`           | 100/300 rpm 自动化采集脚本                     |
| `tools/validate_live_speed_test.py` | VOFA 解码、早期 2 A 验证判据                   |

## 总结

这次移植的核心收获是：真实电机控制里，算法本身只占一部分。Simulink 能给出速度环、电流环和坐标变换的主结构，但真正决定闭环能否稳定复现的是采样时序、电角度交接、保护策略、遥测字段和可重复测试脚本。

最终程序已经形成较完整的闭环：MT6816 位置反馈、1 kHz 速度环、20 kHz Id/Iq 电流环、Clarke/Park/SVPWM、TIM1 三相互补 PWM、LCD 曲线显示、USB CDC 命令、48 通道 VOFA 和 Python 自动化验证。当前版本在 100 rpm 保持、300 rpm 保持和 86 s 自动序列中均未触发 fault/abort，并能在测试结束后回到明确的 idle 安全状态。
