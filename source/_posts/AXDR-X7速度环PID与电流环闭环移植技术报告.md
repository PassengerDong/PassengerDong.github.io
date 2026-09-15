---
title: AXDR X7 速度环 FOC 移植与 300 rpm 调参复盘
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
> 本文记录一次从 X7/Simulink 速度环思路迁移到 AXDR / AxDrive-L 实物平台的完整过程。重点不是“电机能转”，而是把速度环、Id/Iq 电流环、编码器电角度、SVPWM、保护、VOFA 遥测和自动化验证串成一个能反复调参的闭环框架。

<!-- more -->

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
