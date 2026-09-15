---
title: 使用hexo搭建个人博客
date: 2023-10-28 15:22:32
tags: 
category: article
---

# 0基础使用hexo搭建个人博客

## 先叠个甲：我是个菜鸡，如果有无请各位大佬提出助我更正！这个教程主要是提供一个大致的步骤。

hexo是一个简洁高效的博客框架，利用hexo将服务器布局在github上可以做到零成本的个人博客搭建

以下是大体的步骤

1.前期准备

2.hexo本地部署与上传

3.个性化

· 由于我个人是Windows系统，下列的操作我将以Windows系统为例，mac✌的操作步骤也是大致相同的，可以简单的代替一下部分语句进行操作。

### 1.前期准备

##### 首先我们需要创建一个GitHub账户

国内也有一些可以代替的网站比如[Gitee](https://gitee.com/)等，但是没几个可以和GitHub比的，所以原则上我们最推荐GitHub

[Github官网](https://github.com/)

部分用户在打开GitHub时会有一些困难，可以耐心等待（或者开个魔法，也许有帮助？）

具体步骤可以看这里[GitHub注册](https://blog.csdn.net/m0_67906358/article/details/128808210)

##### 然后我们就需要安装git

这是下载的地址 [git](https://git-scm.com/downloads)，你可以选择自己需要的版本下载。

我也丢一个教程在这里：[安装git](https://blog.csdn.net/mukes/article/details/115693833)（绝对不是因为我懒）

安装完之后，任意页面右键出现git相关的选择项（主要是 git brash 就行了）

##### 完成以上步骤之后我们需要配置ssh

老样子，丢个别人的教程 [ssh配置](https://blog.csdn.net/lqlqlq007/article/details/78983879) （就是懒行吧）

##### 之后就是安装node

这是官网：[ndoe.js](https://nodejs.org/en)

**注意：一定要选左边的！**

左边的是稳定版本，更加可靠，右边的是尝鲜版本，不是很稳定！

下载完之后无脑继续就行了

完成安装之后右键打开poweshell或者cmd（**后面我就检测打开终端了**）输入npm，看到版本号就说明安装成功了

由于node是默认安装在**C盘**下面的，如果你对自己的C盘比较不自信，可以给node搬个家（我比较建议搬个家）

你可以在其他盘想要的地方建一个文件夹（一定要英文名称，建议直接nodejs）

然后在里面建node_global和node_cache两个文件夹

打开终端，输入`npm config set prefix "nodejs文件位置\node_global"`

再输入`node list -g`查看是否更改成功（显示empty是正常的）

同样的，我们再更改以下node_cache的位置`npm config set cache "nodejs的位置\node_cache"`

输入`npm install express -g`检测一下（安装报错就用管理员身份重新运行一下

再输入`npm list -g`，这次不是empty说明成功了

**然后就是配置环境了！**

计算机右键属性->高级系统设置->path->编辑

把原来的C:\Users\用户名\AppData\Roaming\npm改为新的地址（node_global的位置）

再新建系统变量NODE_PATH,变量值是node_golbal里面node_modules 的位置

确定之后就配置完成了

##### 配置pnpm

虽然node的npm已经足够大部分的使用了，但是他有一个致命的缺点：**太慢了！**

这个时候我们就需要pnpm了！

pnpm适用范围极光，而且**巨快！！**，安装也相当简单

打开终端，输入`npm install -g pnpm`或者`npm install -g @pnpm/exe`就好了

安装完之后，我们还要配置一下镜像，一般来说用的是淘宝的镜像

终端输入`pnpm get registry`,`pnpm set registry https://registry.npm.taobao.org`

你也可以修改安装包的位置（其实没啥必要我就不展开了）

然后你就可以愉快的使用pnpm了，就是这么简单（pnpm yyds！）

### 2.hexo框架搭建

完成前置点之后我们终于可以开始进入搭建环节了！

先让我们检查一下

终端输入`node -v`,`pnpm -v`和`git --version`

有版本号就说明你已经准备好了

##### 首先链接GitHub

设置用户名和邮箱
`git config --global user.name "GitHub 用户名"`
`git config --global user.email "GitHub 邮箱"`

创建SSH密钥：输入`ssh-keygen -t rsa -C "GitHub邮箱"`然后一路回车

进入用户下的.ssh目录（要开显示隐藏文件），用记事本打开id_rsa.pub并复制里面内容

登录GitHub，进入setting，选择边栏的SSH and GPG keys，点击New SSH key

title随便取，黏贴复制的内容，点Add SSH key完成添加

然后就要**验证链接了**

打开右键打开git brash，输入`ssh -T git@github.com`,出现“Are you sure……",输入yes回车确定

显示“hi ***!……”就成功了

##### 然后创建GitHub Page仓库

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

他会跳出一个本地钉钉网址，按住CTRL点击就可以打开

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

·注：md文件不是普通的txt或doc文件，他的编写也有些简单的语法，即MarkDown语法，具体怎么用可以看官方的文档[MarkDown](https://markdown.com.cn/)

编辑完成并保存之后在blog里打开终端，输入`hexo g`,`hexo d`，一段时间之后你的网站里就会出现你的新文章了

·注：文章更新需要一段时间，一时半会儿没别太急哈

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
	repo: https:///用户名/用户名.github.io.git
	branch: main
```