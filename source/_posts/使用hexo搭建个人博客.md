---
title: 使用 Hexo 搭建个人博客
date: 2023-10-28 15:22:32
updated: 2026-09-18 23:49:32
tags:
  - Hexo 
  - .Net
  - Github
category: article
---
# 0基础使用 Hexo 搭建个人博客

## 先叠个甲：我是个菜鸡，如果有误请各位大佬提出助我更正！这个教程主要是提供一个大致的步骤。

Hexo 是一个简洁高效的博客框架，利用 Hexo 将静态网页部署到 GitHub Pages 上，可以做到零成本的个人博客搭建。

以下是大体的步骤

1.前期准备

2. Hexo 本地部署与上传

3.个性化

· 由于我个人是Windows系统，下列的操作我将以Windows系统为例，mac✌的操作步骤也是大致相同的，可以简单的代替一下部分语句进行操作。

### 1.前期准备

##### 首先我们需要创建一个GitHub账户

国内也有一些可以代替的网站比如[Gitee](https://gitee.com/)等，但是没几个可以和GitHub比的，所以原则上我们最推荐GitHub

[GitHub 官网](https://github.com/)

部分用户在打开GitHub时会有一些困难，可以耐心等待（或者开个魔法，也许有帮助？）

具体步骤可以看这里[GitHub注册](https://blog.csdn.net/m0_67906358/article/details/128808210)

##### 然后我们就需要安装git

这是下载的地址 [git](https://git-scm.com/downloads)，你可以选择自己需要的版本下载。

我也丢一个教程在这里：[安装git](https://blog.csdn.net/mukes/article/details/115693833)（绝对不是因为我懒）

安装完之后，任意页面右键出现 Git 相关的选择项（主要是 Git Bash 就行了）

##### 完成以上步骤之后我们需要配置ssh

老样子，丢个别人的教程 [ssh配置](https://blog.csdn.net/lqlqlq007/article/details/78983879) （就是懒行吧）

##### 之后就是安装node

这是官网：[Node.js](https://nodejs.org/en)

**注意：一定要选左边的！**

左边的是稳定版本，更加可靠，右边的是尝鲜版本，不是很稳定！

下载完之后无脑继续就行了

完成安装之后右键打开 PowerShell 或者 cmd（**后面我就简称打开终端了**）输入 `npm`，看到版本号就说明安装成功了

由于node是默认安装在**C盘**下面的，如果你对自己的C盘比较不自信，可以给node搬个家（我比较建议搬个家）

你可以在其他盘想要的地方建一个文件夹（一定要英文名称，建议直接nodejs）

然后在里面建node_global和node_cache两个文件夹

打开终端，输入`npm config set prefix "nodejs文件位置\node_global"`

再输入`npm list -g`查看是否更改成功（显示 empty 是正常的）

同样的，我们再更改以下node_cache的位置`npm config set cache "nodejs的位置\node_cache"`

输入`npm install express -g`检测一下（安装报错就用管理员身份重新运行一下

再输入`npm list -g`，这次不是empty说明成功了

**然后就是配置环境了！**

计算机右键属性->高级系统设置->path->编辑

把原来的C:\Users\用户名\AppData\Roaming\npm改为新的地址（node_global的位置）

再新建系统变量 NODE_PATH，变量值是 node_global 里面 node_modules 的位置

确定之后就配置完成了

##### 配置pnpm

虽然node的npm已经足够大部分的使用了，但是他有一个致命的缺点：**太慢了！**

这个时候我们就需要pnpm了！

pnpm 适用范围极广，而且**巨快！！**，安装也相当简单

打开终端，输入`npm install -g pnpm`或者`npm install -g @pnpm/exe`就好了

安装完之后，我们还要配置一下镜像，一般来说用的是淘宝的镜像

终端输入`pnpm get registry`,`pnpm set registry https://registry.npm.taobao.org`

你也可以修改安装包的位置（其实没啥必要我就不展开了）

然后你就可以愉快的使用pnpm了，就是这么简单（pnpm yyds！）

### 2. Hexo 框架搭建

完成前置点之后我们终于可以开始进入搭建环节了！

先让我们检查一下

终端输入`node -v`,`pnpm -v`和`git --version`

有版本号就说明你已经准备好了

##### 首先连接 GitHub

设置用户名和邮箱
`git config --global user.name "GitHub 用户名"`
`git config --global user.email "GitHub 邮箱"`

创建SSH密钥：输入`ssh-keygen -t rsa -C "GitHub邮箱"`然后一路回车

进入用户下的.ssh目录（要开显示隐藏文件），用记事本打开id_rsa.pub并复制里面内容

登录GitHub，进入setting，选择边栏的SSH and GPG keys，点击New SSH key

title 随便取，粘贴刚刚复制的内容，点 Add SSH key 完成添加

然后就要**验证链接了**

右键打开 Git Bash，输入`ssh -T git@github.com`，出现“Are you sure……”，输入 yes 回车确定

显示“hi ***!……”就成功了

##### 然后创建 GitHub Pages 仓库

GitHub主页右上角加号 -> New repository

·仓库名输入 用户名.github.io（必须是这个格式）

·勾选“Initialize this repository with a README”

其他随便

最后点 Create repository

##### 开始正式搭建

先在自己喜欢的位置创建一个文件夹（名字要是英文，建议直接blog，我就称这个文件夹为blog了）

在blog里右键打开终端，输入`pnpm install -g hexo-cli`一键安装博客

这个时候就可直观体会pnpm和npm的区别了，npm半天才能安装完，而pnpm只需要短短几秒

下一步初始化并安装组件

输入：`hexo init`,`npm install`就完成了

是不是非常迅速？✌

现在让我们启动一下试试

输入`hexo g`完成本地部署

再输入`hexo s`启动服务器

它会跳出一个本地调试网址，按住 CTRL 点击就可以打开

如果正常的打开了一个网址，恭喜你！你已经成功搭建了一个个人博客！（虽然只是在本地）

下一步就是把你的博客部署到GitHub上了！

按CTRL加C退出hexo，让我们先安装点插件

首先，安装hexo-deployer-git:`pnpm install hexo-deployer-git --save`

然后打开blog里面_config.yml文件的deployment部分，改成这样：

```
deploy:
  type: git
  repository: git@github.com:用户名/用户名.github.io.git
  branch: master
```

完成之后输入`hexo d`将网站上传部署到GitHub上

在网页输入`https://用户名.github.io`就可以上你的个人博客了~

##### 在个人博客上上传自己的文章

创建文章的快捷输入方式是`hexo n "文章名称"`

创建之后就可以在blog里面blog\source\_posts位置找到新建的文章（结尾是.md）

用vscode打开这个文件就可以编辑了！

·注：md 文件不是普通的 txt 或 doc 文件，它的编写也有些简单的语法，即 Markdown 语法，具体怎么用可以看官方的文档 [Markdown](https://markdown.com.cn/)

编辑完成并保存之后在blog里打开终端，输入`hexo g`,`hexo d`，一段时间之后你的网站里就会出现你的新文章了

·注：文章更新需要一段时间，一时半会儿没更新别太急

## 更适合长期维护的目录和发布流程

博客真正开始长期更新以后，最容易失控的部分通常不是 Hexo 命令，而是文件组织。建议在初始化之后就把配置、文章、图片和主题分开管理：`source/_posts` 只放 Markdown 文章，`source/img/articles` 放文章正文图片，`source/img/portfolio` 放项目封面和项目展示图，`themes` 保存主题修改，`_config.yml` 保存站点级配置，主题专属配置则放在单独的 `_config.主题名.yml` 中。这样更换主题或整理图片时，不容易把文章正文里的相对路径一起弄乱。

如果一篇文章包含多张图片，最好在对应目录下再建立一个以文章 permalink 或项目 slug 命名的文件夹。例如速度环文章可以使用 `source/img/articles/axdr-x7-speedloop-pid-current-loop/`，硬件项目可以使用 `source/img/portfolio/3-6s-smart-power-distribution-board/`。正文统一使用 `/img/articles/...` 或 `/img/portfolio/...` 这样的站点绝对路径，避免 Markdown 文件移动到其他目录后图片失效。封面图和正文图也要区分，封面只在 front matter 的 `cover_image` 中配置，正文则在 Markdown 中逐张引用。

文章头部信息建议固定成一套格式。`title`、`date`、`updated`、`categories`、`tags`、`permalink` 和 `cover_image` 的职责不同，不要把所有内容都塞进 TAG。TAG 每篇控制在五个以内，只保留具体技术栈、芯片、协议、算法、工具链或关键器件，例如 `STM32G474`、`CAN`、`SVPWM`、`Simulink`、`Pug`；“电调”“分电板”“智能车”这类只描述文章主题的泛词更适合放在标题、分类或摘要里。

当前站点还可以通过 `hexo-wordcount` 显示文章总字数和预计阅读时间，通过 Utterances 把 GitHub Issues 作为评论区。主题模板中应把这些功能放在文章信息区和正文末尾，并保留关闭开关，方便个别草稿或特殊页面隐藏。修改 Pug 模板后不要只看源文件，必须重新执行生成，再在 `public` 目录中确认生成页面包含字数、阅读时间、评论容器和正确的脚本地址。

## 发布前检查清单

每次准备发布时，可以按照“内容、资源、生成、部署”四步检查。内容方面确认 front matter 的缩进、日期格式、分类和 TAG 数量；资源方面检查图片路径大小写、文件扩展名和中文文件名，避免本地能打开而部署后 404；生成方面先运行 `pnpm exec hexo clean`，再运行 `pnpm exec hexo generate`，观察终端是否出现模板错误、资源复制失败或 Markdown 解析警告；部署方面确认 `public` 已生成最新页面，再执行 `pnpm exec hexo deploy` 或项目中封装好的部署脚本。

如果页面没有更新，先判断问题发生在哪一层。浏览器仍显示旧内容，可能是缓存或 CDN；`public` 中没有新文章，通常是 front matter、文件编码或文章路径问题；生成过程中报 Pug 错误，应优先检查主题模板和变量是否存在；图片 404 则检查图片是否真的位于 `source/img` 下，以及文章引用是否以 `/img/` 开头。把这些问题分类后，排查会比反复执行 `hexo d` 更快。

对于包含工程图片和测试数据的技术文章，还应在正文中明确图片用途、测试条件和结论边界。例如电流测试要写清楚是输入电流、相电流还是峰值，温升要写明环境温度和持续时间，飞行验证要区分“完成上机”与“长期可靠性已验证”。博客不仅是展示页面，也是工程记录，保留这些条件可以让读者在几年后仍然知道哪些结果可以复现、哪些只是阶段性观察。

### 个人博客主页个性化

首先，你要找一个喜欢的个性化页面

这里我个人比较建议hexo自己给的个性化库[hexo个性化库](https://hexo.io/themes/)

去里面找一个自己喜欢的模板，打开其对应的GitHub库，跟着操作一步步走就行了👍

各个模板的操作可能不一样，我就不细说了，剩下就交给你自己慢慢探索了

### 后记

#### 关于GitHub换名之后

GitHub换名之后会导致hexo博客无法正常登录，需要进行一定操作来恢复。

1. 更换仓库名为： 新用户名.github.io
2. 更新配置文件：在博客根目录下找到 _config.yml 文件，将用户名改为新用户名。
   配置文件就该后大致如下：

```
deploy:
	type: git
	repo: https://github.com/用户名/用户名.github.io.git
	branch: main
```
